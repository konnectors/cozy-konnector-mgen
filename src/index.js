import { ContentScript } from 'cozy-clisk/dist/contentscript'
import Minilog from '@cozy/minilog'
import { parse, format, subMonths } from 'date-fns'
import { blobToBase64 } from 'cozy-clisk/dist/contentscript/utils'
import ky from 'ky'
import waitFor, { TimeoutError } from 'p-wait-for'
const log = Minilog('ContentScript')
Minilog.enable('mgenCCC')

const baseUrl = 'https://www.mgen.fr'
const loginFormUrl = 'https://www.mgen.fr/login-adherent/'
const accountUrl = 'https://www.mgen.fr/mon-espace-perso/'

let userInfos = []
let configInfos = []

// The override here is needed to intercept XHR requests made during the navigation for user personnal informations
var proxied = window.XMLHttpRequest.prototype.open
window.XMLHttpRequest.prototype.open = function () {
  var originalResponse = this
  if (
    arguments[1].includes(
      '/attestation-generique/attestation/eligibilite?noIde='
    )
  ) {
    originalResponse.addEventListener('readystatechange', function () {
      if (originalResponse.readyState === 4) {
        const jsonInfos = JSON.parse(originalResponse.responseText)
        userInfos.push(jsonInfos)
      }
    })
    return proxied.apply(this, [].slice.call(arguments))
  }

  if (arguments[1].includes('/assets/config.json')) {
    originalResponse.addEventListener('readystatechange', function () {
      if (originalResponse.readyState === 4) {
        const jsonInfos = JSON.parse(originalResponse.responseText)
        configInfos.push(jsonInfos)
      }
    })
    return proxied.apply(this, [].slice.call(arguments))
  }

  return proxied.apply(this, [].slice.call(arguments))
}

class MgenContentScript extends ContentScript {
  async navigateToLoginForm() {
    this.log('info', '🤖 navigateToLoginForm')
    await this.goto(loginFormUrl)
    await Promise.race([
      this.waitForElementInWorker('#user'),
      this.waitForElementInWorker(
        '.btn-logout-group > a[href*="https://www.mgen.fr/mon-espace-perso/?tx_mtechmgenconnectxmlhttp_mtechmgenconnectlistepartenairesxmlhttp"]'
      )
    ])
  }

  onWorkerEvent({ event, payload }) {
    this.log('info', 'onWorkerEvent starts')
    if (event === 'loginSubmit') {
      this.log('info', 'received loginSubmit, blocking user interactions')
      this.blockWorkerInteractions()
      const { email, password } = payload || {}
      if (email && password) {
        this.saveCredentials({ email, password })
      }
    } else if (event === 'loginError') {
      this.log(
        'info',
        'received loginError, unblocking user interactions: ' + payload?.msg
      )
      this.unblockWorkerInteractions()
    }
  }

  async ensureAuthenticated({ account }) {
    this.log('info', '🤖 ensureAuthenticated')
    this.bridge.addEventListener('workerEvent', this.onWorkerEvent.bind(this))
    if (!account) {
      await this.ensureNotAuthenticated()
    }
    await this.navigateToLoginForm()
    const authenticated = await this.runInWorker('checkAuthenticated')
    if (!authenticated) {
      this.log('info', 'Not authenticated')
      let credentials = await this.getCredentials()
      if (credentials && credentials.email && credentials.password) {
        try {
          this.log('info', 'Got credentials, trying autologin')
          await this.tryAutoLogin(credentials)
        } catch (error) {
          this.log('warn', 'autoLogin error' + error.message)
          await this.showLoginFormAndWaitForAuthentication()
        }
      } else {
        this.log('info', 'No credentials found, waiting for user input')
        await this.showLoginFormAndWaitForAuthentication()
      }
    }
    const stayLoggedSelector =
      '.btn-logout-group > a[href="/mon-espace-perso/"]'
    if (await this.isElementInWorker(stayLoggedSelector)) {
      await this.clickAndWait(
        '.btn-logout-group > a[href="/mon-espace-perso/"]',
        '#listeRemboursementsSante'
      )
    }
    this.unblockWorkerInteractions()
    return true
  }

  async ensureNotAuthenticated() {
    this.log('info', '🤖 ensureNotAuthenticated')
    await this.navigateToLoginForm()
    const authenticated = await this.runInWorker('checkAuthenticated')
    if (!authenticated) {
      this.log('info', 'ensureNotAuthenticated - Not auth')
      return true
    }
    this.log('info', 'ensureNotAuthenticated - LogOut')
    await this.clickAndWait(
      '.btn-logout-group > a[href*="https://www.mgen.fr/mon-espace-perso/?tx_mtechmgenconnectxmlhttp_mtechmgenconnectlistepartenairesxmlhttp"]',
      '#user'
    )
    return true
  }

  onWorkerReady() {
    this.log('info', `onWorkerReady starts`)
    window.addEventListener('DOMContentLoaded', () => {
      const button = document.querySelector('#loginBtn')
      if (button) {
        button.addEventListener('click', () => {
          const password = document.querySelector('#pass')?.value
          const email = document.querySelector('#user')?.value
          this.bridge.emit('workerEvent', {
            event: 'loginSubmit',
            payload: { email, password }
          })
        })
      }
      const error = document.querySelector('.alert-danger')
      if (error) {
        this.bridge.emit('workerEvent', 'loginError', { msg: error.innerHTML })
      }
    })
  }

  async checkAuthenticated() {
    this.log('info', 'checkauthenticated starts')
    if (
      document.querySelector(
        '.btn-logout-group > a[href*="https://www.mgen.fr/mon-espace-perso/?tx_mtechmgenconnectxmlhttp_mtechmgenconnectlistepartenairesxmlhttp"]'
      )
    ) {
      this.log('info', 'Auth detected - logoutButton')
      return true
    }

    return Boolean(
      document.querySelector('#listeRemboursementsSante') &&
        document.querySelector('.deconnexion_auth_link')
    )
  }

  async findAndSendCredentials(loginField, passwordField) {
    this.log('info', 'findAndSendCredentials starts')
    let userLogin = loginField.value
    let userPassword = passwordField.value
    const userCredentials = {
      email: userLogin,
      password: userPassword
    }
    return userCredentials
  }

  async showLoginFormAndWaitForAuthentication() {
    log.debug('showLoginFormAndWaitForAuthentication start')
    await this.setWorkerState({ visible: true })
    await this.runInWorkerUntilTrue({
      method: 'waitForAuthenticated'
    })
    await this.setWorkerState({ visible: false })
  }

  async getUserDataFromWebsite() {
    this.log('info', '🤖 getUserDataFromWebsite')
    await this.waitForElementInWorker(
      'a[href="/mon-espace-perso/rubrique/telecharger-attestations/"]'
    )
    await this.clickAndWait(
      'a[href="/mon-espace-perso/rubrique/telecharger-attestations/"]',
      '.mtech_ressources_carte'
    )
    await this.clickAndWait(
      '.mtech_ressources_carte > div > a',
      'button[aria-label="Télécharger Attestation de droits"]'
    )
    await this.runInWorkerUntilTrue({
      method: 'checkInterception',
      args: ['userInfos']
    })
    await this.runInWorker('getIdentity')
    if (!this.store.userIdentity?.email) {
      throw new Error(
        'getUserDataFromWebsite: Could not find a email in user identity'
      )
    }
    return {
      sourceAccountIdentifier: this.store.userIdentity.email
    }
  }

  async fetch(context) {
    this.log('info', '🤖 fetch')
    await this.saveIdentity({ contact: this.store.userIdentity })
    await this.runInWorkerUntilTrue({
      method: 'checkInterception',
      args: ['configInfos']
    })
    const attestationAndCard = await this.runInWorker('getAttestationAndCard')
    await this.saveFiles(attestationAndCard, {
      context,
      contentType: 'application/pdf',
      fileIdAttributes: ['filename'],
      qualificationLabel: 'other_health_document'
    })
    await this.goto(accountUrl)
    await this.waitForElementInWorker('#listeRemboursementsSante')
    await this.fetchBills(context)
  }

  async tryAutoLogin(credentials) {
    this.log('info', 'TryAutologin starts')
    await this.autoLogin(credentials)
    await this.waitForElementInWorker('.deconnexion_auth_link')
  }

  async autoLogin(credentials) {
    this.log('info', 'AutoLogin starts')
    await this.waitForElementInWorker('#user')
    await this.runInWorker('fillText', '#user', credentials.email)
    await this.runInWorker('fillText', '#pass', credentials.password)
    // Here we need to wait for an invisble captcha to finish to be able to send the login form
    await this.runInWorkerUntilTrue({ method: 'checkCaptcha' })
    await this.runInWorker('click', '#loginBtn')
  }

  async getAttestationAndCard() {
    this.log('info', 'getAttestationAndCard starts')
    const allAttestations = []
    const documents = await this.fetchDocuments()
    for (const document of documents) {
      const oneDoc = {
        filename: document.nom,
        dataUri: `data:application/pdf;base64,${document.flux}`,
        shouldReplaceFile: () => true,
        date: new Date(),
        vendor: 'MGEN',
        fileAttributes: {
          metadata: {
            contentAuthor: 'mgen.fr',
            issueDate: new Date(),
            datetime: new Date(),
            datetimeLabel: 'issueDate',
            carbonCopy: true
          }
        }
      }
      allAttestations.push(oneDoc)
    }
    return allAttestations
  }

  async downloadFileInWorker(entry) {
    const { fileurl, formDataArray, queryParams } = entry

    let searchParams = new FormData()
    formDataArray.forEach(item => {
      searchParams.set(item.inputName, item.inputValue)
    })
    for (const i in queryParams) {
      searchParams.set(i, queryParams[i])
    }

    const response = await ky
      .post(fileurl, {
        body: searchParams
      })
      .blob()

    return await blobToBase64(response)
  }

  async fetchDocuments() {
    this.log('info', 'fetchDocuments starts')
    const attestationsToCompute = []
    const foundInfos = userInfos[0].records[0]
    const foundConfig = configInfos[0]
    const apiKey = foundConfig.apim.apiKey
    const authInfos = JSON.parse(window.localStorage.getItem('auth-info'))
    const token = authInfos.access_token
    const tokenType = authInfos.token_type
    const attestationPostInfos = {
      typeAttestation: 'ATTESTATION_RO',
      personneEligible: {
        ...foundInfos
      },
      topExoTM: foundInfos.topExoTM
    }
    const headers = {
      Accept: '*/*',
      'Accept-Encoding': 'gzip, deflate, br',
      'Api-Key': apiKey,
      Authorization: `${tokenType} ${token}`,
      'Content-Type': 'application/json'
    }
    const attestationResponse = await ky
      .post(
        'https://api.mgen.fr/prod24/espace-perso/v1/attestation-generique/attestation/telecharger',
        {
          headers,
          body: JSON.stringify(attestationPostInfos),
          timeout: 30000
        }
      )
      .json()
    attestationsToCompute.push(attestationResponse)
    const mutualCardPostInfos = {
      typeAttestation: 'ATTESTATION_RC',
      personneEligible: {
        ...foundInfos
      },
      topExoTM: foundInfos.topExoTM
    }
    const cardResponse = await ky
      .post(
        'https://api.mgen.fr/prod24/espace-perso/v1/attestation-generique/attestation/telecharger',
        {
          headers,
          body: JSON.stringify(mutualCardPostInfos),
          timeout: 30000
        }
      )
      .json()
    attestationsToCompute.push(cardResponse)
    return attestationsToCompute
  }

  async fetchBills(context) {
    await this.runInWorker(
      'click',
      'a[href="/mon-espace-perso/mes-remboursements/"]'
    )
    await Promise.all([
      this.waitForElementInWorker('#tableDernierRemboursement'),
      this.waitForElementInWorker('#sectionRechercheRemboursements'),
      this.waitForElementInWorker('ol')
    ])
    await this.runInWorkerUntilTrue({ method: 'checkNumberOfBills' })

    let hasNextPeriod = true
    let blankPeriodsInARow = 0
    while (hasNextPeriod) {
      let hasNextPage = true
      const billsArray = []
      while (hasNextPage) {
        const foundBillsLength = await this.evaluateInWorker(
          function getBillsLength() {
            return document.querySelectorAll('.ligne-remboursement').length
          }
        )
        for (let i = 0; i < foundBillsLength; i++) {
          const oneBill = await this.runInWorker('getBills', i)
          if (oneBill === null) {
            this.log('info', 'No pdf to download for this file, jumping it')
            continue
          }
          billsArray.push(oneBill)
        }
        hasNextPage = await this.runInWorker('checkNextPage')
        if (hasNextPage) {
          this.log('info', 'nextPage condition')
          // The click not really load a page, it's just changing table infos wich is pretty much instantaneous
          // No need to delete elements or wait for any selectors
          await this.runInWorker('click', '#tableDernierRemboursement_next')
        }
      }
      await this.saveBills(billsArray, {
        context,
        contentType: 'application/pdf',
        fileIdAttributes: ['vendorRef'],
        qualificationLabel: 'health_invoice'
      })
      this.log('info', 'All bills for this period has been treated')

      await this.changePeriod()
      if (await this.isElementInWorker('#noRembFocus')) {
        this.log('info', 'This period has no bills, continue')
        blankPeriodsInARow++
        // As we cannot know when the user subscribed on the website, we assume if there is 3 periods in a row without bills,
        // we should have reached beyond the user's subscription date
        if (blankPeriodsInARow === 3) {
          this.log('info', 'No more bills found, fetch completed')
          hasNextPeriod = false
          continue
        }
      } else {
        this.log('info', 'Blank row ends, found bills for this period')
        blankPeriodsInARow = 0
      }
    }
    this.log('info', 'All available bills for all periods has been saved')
  }

  async checkInterception(interceptionType) {
    this.log('info', `checkInterception starts - ${interceptionType}`)
    if (interceptionType === 'userInfos') {
      await waitFor(
        () => {
          if (userInfos.length > 0) {
            return true
          } else {
            return false
          }
        },
        {
          interval: 100,
          timeout: {
            milliseconds: 10000,
            message: new TimeoutError('checkInterception timed out after 10sec')
          }
        }
      )
    }
    if (interceptionType === 'configInfos') {
      await waitFor(
        () => {
          if (configInfos.length > 0) {
            return true
          } else {
            return false
          }
        },
        {
          interval: 100,
          timeout: {
            milliseconds: 10000,
            message: new TimeoutError('checkInterception timed out after 10sec')
          }
        }
      )
    }

    return true
  }

  async checkCaptcha() {
    this.log('info', 'checkCaptcha starts')
    await waitFor(
      () => {
        const captcahToken = document.querySelector('#li-antibot-token')?.value
        if (captcahToken.length === 0) {
          this.log('info', 'Invisble captcha not finished')
          return false
        } else {
          this.log('info', 'Invisble captcha done, continue autologin')
          return true
        }
      },
      {
        interval: 1000,
        timeout: {
          milliseconds: 10000,
          message: new TimeoutError('checkCaptcha timed out after 10sec')
        }
      }
    )
    return true
  }

  async getIdentity() {
    this.log('info', 'getIdentity starts')
    const foundInfos = userInfos[0].records[0]
    const userIdentity = {
      email: foundInfos.adresseEmail,
      socialSecurityNumber: foundInfos.numInsee,
      birthDate: foundInfos.dateNaissance,
      name: {
        givenName: foundInfos.prenom,
        familyName: foundInfos.nom
      },
      address: []
    }
    const foundAddress = foundInfos.adressePostale

    const computedAddress = this.getAddress(foundAddress)
    userIdentity.address.push(computedAddress)
    await this.sendToPilot({ userIdentity })
  }

  getAddress(foundAddress) {
    this.log('info', 'getAddress starts')
    const object = {}
    let formattedAddress = ''

    if (foundAddress.bpOuLieuDit) {
      object.locality = foundAddress.bpOuLieuDit
      formattedAddress = `${formattedAddress}${object.locality} `
    }
    if (foundAddress.etageEscalierAppartement) {
      object.floorIndicator = foundAddress.etageEscalierAppartement
      formattedAddress = `${formattedAddress}${object.floorIndicator} `
    }
    if (foundAddress.immeubleBatimentResidence) {
      object.buildingIndicator = foundAddress.immeubleBatimentResidence
      formattedAddress = `${formattedAddress}${object.buildingIndicator} `
    }
    if (foundAddress.indicateurRepetition) {
      object.addressComplement = foundAddress.indicateurRepetition
      formattedAddress = `${formattedAddress}${object.addressComplement} `
    }
    if (foundAddress.numVoie) {
      object.streetNumber = foundAddress.numVoie
      formattedAddress = `${formattedAddress}${object.streetNumber} `
    }
    if (foundAddress.libelleVoie) {
      object.street = foundAddress.libelleVoie
      formattedAddress = `${formattedAddress}${object.street} `
    }
    if (foundAddress.codePostal) {
      object.postCode = foundAddress.codePostal
      formattedAddress = `${formattedAddress}${object.postCode} `
    }
    if (foundAddress.localisation) {
      object.city = foundAddress.localisation
      formattedAddress = `${formattedAddress}${object.city}`
    }

    object.formattedAddress = formattedAddress

    return object
  }

  async getBills(i) {
    this.log('info', 'getBills starts')
    const foundBillsElements = document.querySelectorAll('.ligne-remboursement')
    const innerHTMLForOneBill = []
    const infosElements = foundBillsElements[i].querySelectorAll('td')
    for (let j = 0; j < infosElements.length; j++) {
      if (j === infosElements.length - 1) {
        this.log('info', 'last row, not containing anything usefull')
        continue
      }
      innerHTMLForOneBill.push(infosElements[j].innerHTML)
    }
    const [
      foundTreatmentDate,
      nameInfos,
      pdfInfos,
      foundReimbursmentDate,
      foundAmount
    ] = innerHTMLForOneBill
    const treatmentDate = parse(foundTreatmentDate, 'dd/MM/yyyy', new Date())
    const reimbursmentDate = parse(
      foundReimbursmentDate,
      'dd/MM/yyyy',
      new Date()
    )
    const beneficiary = nameInfos.replace(/\s/g, ' ').trim()
    const amountAndCurrency = foundAmount
      .replace(/\s/g, ' ')
      .split('<br>')[0]
      .trim()
    let foundFilehref
    if (pdfInfos.match(/href="([^"]*)"/)) {
      foundFilehref = pdfInfos.match(/href="([^"]*)"/)[1]
    } else {
      return null
    }
    const filehref = decodeURIComponent(foundFilehref).replace(/&amp;/g, '&')
    const fileurl = `${baseUrl}${filehref}`
    const vendorRef = pdfInfos.match(/data-url-releve="([^"]*)"/)[1]
    const [amount, currency] = amountAndCurrency.split(' ')
    const queryParams = this.getRequestOptions(fileurl)
    const requestFormInputs = document.querySelectorAll(
      '#formDetailsRemboursement > div > input'
    )
    const formDataArray = []
    for (const input of requestFormInputs) {
      const inputName = input.getAttribute('name')
      const inputValue = input.getAttribute('value')
      formDataArray.push({ inputName, inputValue })
    }
    const oneBill = {
      vendorRef,
      date: treatmentDate,
      treatmentDate,
      reimbursmentDate,
      beneficiary,
      fileurl,
      formDataArray,
      queryParams,
      filename: `${format(
        treatmentDate,
        'yyyy-MM-dd'
      )}_MGEN_${amount}${currency}.pdf`,
      amount: parseFloat(amount.replace(',', '.')),
      currency,
      vendor: 'MGEN',
      fileAttributes: {
        metadata: {
          contentAuthor: 'mgen.fr',
          issueDate: new Date(),
          datetime: treatmentDate,
          datetimeLabel: 'issueDate',
          carbonCopy: true
        }
      }
    }
    return oneBill
  }

  checkNextPage() {
    this.log('info', 'checkNextPage starts')
    const nextPagebutton = document.querySelector(
      '#tableDernierRemboursement_next'
    )
    if (nextPagebutton) {
      return !nextPagebutton.classList.contains('disabled')
    }
    return false
  }

  getRequestOptions(url) {
    this.log('info', 'getRequestOptions starts')
    const decodedUrl = decodeURIComponent(url).replace(/amp;/g, '')
    const params = this.getQueryParams(decodedUrl)
    const sortedParams = this.sortObjectByKey(params)
    return sortedParams
  }

  getQueryParams(url) {
    this.log('info', 'getQueryParams starts')
    const searchParams = new URLSearchParams(new URL(url).search)
    const paramsObj = {}
    for (const [key, value] of searchParams.entries()) {
      paramsObj[key] = value
    }
    return paramsObj
  }

  sortObjectByKey(obj) {
    this.log('info', 'sortObjectByKey starts')
    return Object.keys(obj)
      .sort()
      .reduce((sortedObj, key) => {
        sortedObj[key] = obj[key]
        return sortedObj
      }, {})
  }

  async checkNumberOfBills() {
    this.log('info', 'checkNumberOfBills starts')
    await waitFor(
      () => {
        const elementsLength = document.querySelectorAll(
          '.ligne-remboursement'
        ).length
        // Base on 20 because this is the maximum number of bills per page
        if (elementsLength <= 20) {
          this.log('debug', 'Bills table is ready')
          return true
        }
        return false
      },
      {
        interval: 100,
        timeout: {
          milliseconds: 10000,
          message: new TimeoutError('checkNumberOfBills timed out after 10sec')
        }
      }
    )
    return true
  }

  async changePeriod() {
    this.log('info', 'changePeriod starts')
    const periodStartDate = await this.evaluateInWorker(
      function getStartDate() {
        return document.querySelector('#remboursementDateDebut').value
      }
    )
    // To change periods, we're getting the startDate of the actual period, substract 6 months to get the new startDate
    // and use the actual startDate as the endDate for the next period.
    const nextPeriodStartDate = await this.getSubstractedDate(periodStartDate)
    await this.navigateToNextPeriod(periodStartDate, nextPeriodStartDate)
  }

  getSubstractedDate(inputDate) {
    this.log('info', 'getSubstractedDate starts')
    const parsedDate = parse(inputDate, 'dd/MM/yyyy', new Date())
    const newDate = subMonths(parsedDate, 6)
    return format(newDate, 'dd-MM-yyyy')
  }

  async navigateToNextPeriod(endDate, startDate) {
    this.log('info', 'navigateToNextPeriod starts')
    await this.runInWorker('changePeriodValues', endDate, startDate)
    await this.runInWorker('click', 'input[value="Rechercher"]')
    await Promise.race([
      this.waitForElementInWorker('#tableDernierRemboursement'),
      this.waitForElementInWorker('#noRembFocus')
    ])
  }

  changePeriodValues(endDate, startDate) {
    document.querySelector('#remboursementDateDebut').value = startDate
    document.querySelector('#remboursementDateFin').value = endDate
    const noBillselement = document.querySelector('#noRembFocus')
    const billsTable = document.querySelector('#tableDernierRemboursement')
    // Removing table containing the bills or the noBills element to be able to wait for it after changing the period
    if (billsTable) {
      this.log('info', 'Removing billsTable')
      billsTable.remove()
    }
    if (noBillselement) {
      this.log('info', 'Removing noBillsElement')
      noBillselement.remove()
    }
  }
}

const connector = new MgenContentScript()
connector
  .init({
    additionalExposedMethodsNames: [
      'getBills',
      'checkNextPage',
      'checkNumberOfBills',
      'checkInterception',
      'getIdentity',
      'getAttestationAndCard',
      'changePeriod',
      'changePeriodValues',
      'checkCaptcha'
    ]
  })
  .catch(err => {
    log.warn(err)
  })
