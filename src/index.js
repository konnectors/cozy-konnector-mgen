// Force sentry DSN into environment variables
// In the future, will be set by the stack
process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://3da293a66f31422fb395c917a7736405:752fb919797c4082a8a330a452dc6449@sentry.cozycloud.cc/15'

const sumBy = require('lodash/sumBy')
const groupBy = require('lodash/groupBy')
const round = require('lodash/round')
const querystring = require('querystring')
const {
  BaseKonnector,
  requestFactory,
  log,
  saveFiles,
  saveBills,
  errors
} = require('cozy-konnector-libs')
const moment = require('moment')
const bluebird = require('bluebird')
const removeOldFiles = require('./removeOldFiles')

let request = requestFactory()
const j = request.jar()
request = requestFactory({
  cheerio: true,
  json: false,
  // debug: true,
  jar: j
})

const baseUrl = 'https://www.mgen.fr'

const connector = new BaseKonnector(start)

function start(fields) {
  return connector
    .logIn(fields)
    .then(connector.fetchCards)
    .then(connector.getSectionsUrls)
    .then(sections => {
      return connector
        .fetchAttestationMutuelle(sections.mutuelle, fields)
        .then(() => connector.fetchReimbursements(sections.reimbursements))
    })
    .then(async entries => {
      await saveBills(entries, fields.folderPath, {
        identifiers: 'MGEN'
      })
      return entries
    })
    .then(async entries => {
      if (process.env.NODE_ENV !== 'standalone') {
        await removeOldFiles(fields, entries)
      }
      return entries
    })
}

connector.logIn = function(fields) {
  log('info', 'Logging in')
  return request({
    url: 'https://www.mgen.fr/login-adherent/',
    method: 'POST',
    formData: {
      typeConnexion: 'adherent',
      user: fields.login,
      pass: [fields.password],
      logintype: 'login',
      redirect_url: '/mon-espace-perso/'
    },
    resolveWithFullResponse: true
  }).then(response => {
    if (response.request.uri.pathname === '/services-indisponibles/') {
      throw new Error(errors.VENDOR_DOWN)
    }

    const $ = response.body

    if ($('.tx-felogin-pi1').length > 0) {
      const errorMessage = $('.tx-felogin-pi1 .alert-danger')
        .text()
        .trim()
      log('error', errorMessage)
      if (errorMessage.includes('le compte a été bloqué')) {
        throw new Error('LOGIN_FAILED.TOO_MANY_ATTEMPTS')
      }
      throw new Error(errors.LOGIN_FAILED)
    }

    return $
  })
}

connector.fetchCards = function() {
  // first fetches profilage data or else the next request won't work
  return request({
    url: `${baseUrl}/mon-espace-perso/?type=30303&_=${new Date().getTime()}`,
    json: true
  }).then(() =>
    request(
      'https://www.mgen.fr/mon-espace-perso/?type=30304&_=' +
        new Date().getTime()
    )
  )
}

connector.getSectionsUrls = function($) {
  log('info', 'Getting sections urls')
  const result = {}
  const $linkMutuelle = $(
    "a[href*='attestation-de-droit-regime-complementaire']"
  )
  if ($linkMutuelle.length) {
    const matriceMutuelle = $linkMutuelle
      .closest('[data-tag-metier-attestations-demarches]')
      .attr('data-matrice')
    const urlMutuelle = unescape($linkMutuelle.attr('href'))
    result.mutuelle = `${baseUrl}${urlMutuelle}&codeMatrice=${matriceMutuelle}`
  } else {
    result.mutuelle = false
  }

  const $linkReimbursements = $("a[href*='mes-remboursements']")
  const matriceReimbursements = $linkReimbursements
    .closest('[data-tag-metier-remboursements]')
    .attr('data-matrice')
  const urlReimbursements = unescape($linkReimbursements.attr('href'))
  if (urlReimbursements && matriceReimbursements) {
    result.reimbursements = `${baseUrl}${urlReimbursements}&codeMatrice=${matriceReimbursements}`
  } else {
    result.reimbursements = false
  }

  log('debug', result, 'SectionsUrls')

  return result
}

function serializedFormToFormData(data) {
  return data.reduce((memo, item) => {
    memo[item.name] = item.value
    return memo
  }, {})
}

const addGroupAmounts = entries => {
  const groups = groupBy(entries, 'fileurl')
  Object.keys(groups).forEach(k => {
    const groupEntries = groups[k]
    const groupAmount = round(sumBy(groupEntries, 'amount'), 2)
    groupEntries.forEach(entry => (entry.groupAmount = groupAmount))
  })
}

connector.fetchReimbursements = function(url) {
  if (!url) {
    log('error', `No page to fetch reimbursements`)
    throw new Error(errors.VENDOR_DOWN)
  }
  log('info', 'Fetching reimbursements')
  return request(url).then($ => {
    // Initialise some form Data for all following POST (pdf and details)
    const $formDetails = $('#formDetailsRemboursement')
    const formData = serializedFormToFormData($formDetails.serializeArray())

    // table parsing
    let entries = Array.from($('#tableDernierRemboursement tbody tr')).map(
      tr => {
        const tds = Array.from($(tr).find('td')).map(td => {
          return $(td)
            .text()
            .trim()
        })

        const date = moment(tds[4], 'DD/MM/YYYY')
        const entry = {
          type: 'health_costs',
          vendor: 'MGEN',
          isRefund: true,
          indexLine: tds[0], // removed later
          originalDate: moment(tds[1], 'DD/MM/YYYY').toDate(),
          beneficiary: tds[2],
          date: date.toDate()
        }

        const $pdfLink = $(tr).find('.pdf_download')
        if ($pdfLink.length) {
          entry.fileurl = baseUrl + unescape($pdfLink.attr('href'))
          const parsedUrl = querystring.decode(entry.fileurl)
          entry.filename = `${moment(parsedUrl.dateReleve).format(
            'YYYY-MM-DD'
          )}_mgen.pdf`
          entry.requestOptions = {
            jar: j,
            method: 'POST',
            form: {...formData,
                   urlReleve: parsedUrl.urlReleve,
                   dattrait: parsedUrl.dattrait,
                   dateReleve: parsedUrl.dateReleve
                  },
          }
        }

        return entry
      }
    )

    // Initialize some form Data for fecthing details
    const propName =
          'tx_mtechremboursementxmlhttp_mtechremboursementsantexmlhttp[rowIdOrder]'
    formData[propName] = entries.map(entry => entry.indexLine).join(',')
    const action = unescape($formDetails.attr('action'))

    return bluebird
      .map(
        entries,
        entry => connector.fetchDetailsReimbursement(entry, action, formData),
        { concurrency: 5 }
      )
      .then(entries => {
        addGroupAmounts(entries)
        return entries
      })
  })
}

// convert a string amount to a float
function convertAmount(amount) {
  return parseFloat(
    amount
      .trim()
      .replace(' €', '')
      .replace(',', '.')
  )
}

connector.fetchDetailsReimbursement = function(entry, action, formData) {
  log('info', `Fetching details for line ${entry.indexLine}`)
  formData['tx_mtechremboursement_mtechremboursementsante[indexLigne]'] =
    entry.indexLine
  return request({
    url: baseUrl + action,
    method: 'POST',
    form: formData
  }).then($ => {
    const $tables = $('#ajax-details-remboursements table')
    const $tableSummary = $tables.eq(0)
    const $tableDetails = $tables.eq(1)
    const data = Array.from($tableSummary.find('tr')).reduce((memo, tr) => {
      const $tds = $(tr).find('td')
      const name = $tds
        .eq(0)
        .text()
        .trim()
      memo[name] = $tds
        .eq(1)
        .text()
        .trim()
      return memo
    }, {})

    entry.originalAmount = convertAmount(data['Montant des soins'])

    // not used anymore
    delete entry.indexLine

    const details = Array.from($tableDetails.find('tbody tr')).map(tr => {
      const $tds = $(tr).find('td')
      return {
        designation: $tds
          .eq(0)
          .text()
          .trim(),
        reimbursementSS: convertAmount($tds.eq(2).text()),
        reimbursementMGEN: convertAmount($tds.eq(3).text())
      }
    })

    if (data["Remboursement à l'assuré"] === '0,00 €') {
      entry.isThirdPartyPayer = true
    }

    // get data from the details table
    const sums = details.reduce(
      (memo, detail) => {
        memo.designation.push(detail.designation)
        memo.reimbursementSS += detail.reimbursementSS
        memo.reimbursementMGEN += detail.reimbursementMGEN
        return memo
      },
      { designation: [], reimbursementSS: 0, reimbursementMGEN: 0 }
    )
    entry.amount = convertAmount(data["Remboursement à l'assuré"])
    // remove duplicates
    sums.designation = Array.from(new Set(sums.designation))
    entry.subtype = sums.designation.join(', ')
    entry.socialSecurityRefund = round(sums.reimbursementSS)
    entry.thirdPartyRefund = round(sums.reimbursementMGEN)

    return entry
  })
}

connector.fetchAttestationMutuelle = function(url, fields) {
  log('info', 'Fetching mutuelle attestation')

  if (url === false) {
    log('info', 'No mutuelle attestation to fetch')
    return Promise.resolve()
  }

  return request(url)
    .then($ => {
      const script = $('#panelAttestationDroitRO')
        .prev('script')
        .html()
      const urls = script
        .trim()
        .split('\n')
        .map(line => unescape(line.match(/'(.*)'/)[1]))
      log('debug', urls, 'urls')

      return request({
        method: 'POST',
        url: baseUrl + urls[0],
        formData: {
          identifiantPersonne: '0',
          modeEnvoi: 'telecharger'
        }
      }).then(() => ({
        requestOptions: {
          jar: j
        },
        fileurl: baseUrl + urls[1],
        filename: 'Attestation_mutuelle.pdf'
      }))
    })
    .then(entry => saveFiles([entry], fields))
}

module.exports = connector
