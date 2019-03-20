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

const request = requestFactory({
  cheerio: true,
  json: false,
  // debug: true,
  jar: true
})

const baseUrl = 'https://www.mgen.fr'

const connector = new BaseKonnector(start)

async function start(fields) {
  await connector.logIn(fields)
  await connector.fetchCards()
  await connector.fetchAttestationMutuelle(fields)
  const entries = await connector.fetchReimbursements()
  if (entries !== false) {
    await saveBills(entries, fields.folderPath, {
      identifiers: 'MGEN'
    })
  } else {
    log('info', 'No need to save Bills')
  }
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

connector.fetchReimbursements = function() {
  log('info', 'Fetching reimbursements')
  const url = 'https://www.mgen.fr/mon-espace-perso/mes-remboursements/'

  return request(url).then($ => {
    if (
      $.html().includes('avez pas de remboursement pour les six derniers mois')
    ) {
      log(
        'warn',
        "No bills, we found 'avez pas de remboursement pour les six derniers mois' in html"
      )
      // This false will be catch and saveBills not execute
      return false
    }
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
            method: 'POST',
            form: {
              ...formData,
              urlReleve: parsedUrl.urlReleve,
              dattrait: parsedUrl.dattrait,
              dateReleve: parsedUrl.dateReleve
            }
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

connector.fetchAttestationMutuelle = async function(fields) {
  log('info', 'Fetching mutuelle attestation')
  try {
    const $ = await request(
      'https://www.mgen.fr/mon-espace-perso/ma-carte-adherent/'
    )
    const $formDetails = $('.formCarteAdhRCPdf')
    const formData = serializedFormToFormData($formDetails.serializeArray())
    const linkPost = $('.formCarteAdhRCPdf').attr('action')
    log('debug', linkPost, 'linkPost')
    const script = $('.carte-adherent-entete')
      .prev('script')
      .html()
    const linkGet = script.match(
      /actionTelechargementCarteAdherentPdf = '(.*)'/
    )[1]
    log('debug', linkGet, 'linkGet')

    // This request is mandatory for the GET of saveFiles
    await request({
      uri: baseUrl + linkPost,
      method: 'POST',
      form: formData
    })

    // Always replace the file
    const entry = {
      fileurl: baseUrl + linkGet,
      filename: 'Attestation_mutuelle.pdf',
      shouldReplaceFile: () => true
    }
    await saveFiles([entry], fields)
  } catch (e) {
    log('warn', 'Error during fetching attestation')
    log('warn', e.message || e)
  }
  return
}

module.exports = connector
