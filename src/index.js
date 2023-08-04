import { ContentScript } from 'cozy-clisk/dist/contentscript'
import Minilog from '@cozy/minilog'
import { parse, format } from 'date-fns'
import { blobToBase64 } from 'cozy-clisk/dist/contentscript/utils'
import ky from 'ky'
import waitFor, { TimeoutError } from 'p-wait-for'
const log = Minilog('ContentScript')
Minilog.enable('mgenCCC')

const baseUrl = 'https://www.mgen.fr'
const loginFormUrl = 'https://www.mgen.fr/login-adherent/'
const accountUrl = 'https://www.mgen.fr/mon-espace-perso/'

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

  onWorkerEvent(event, payload) {
    if (event === 'loginSubmit') {
      this.log('info', 'received loginSubmit, blocking user interactions')
      this.blockWorkerInteractions()
    } else if (event === 'loginError') {
      this.log(
        'info',
        'received loginError, unblocking user interactions: ' + payload?.msg
      )
      this.unblockWorkerInteractions()
    }
  }

  async ensureAuthenticated({ account }) {
    this.bridge.addEventListener('workerEvent', this.onWorkerEvent.bind(this))
    this.log('info', '🤖 ensureAuthenticated')
    // if (!account) {
    //   await this.ensureNotAuthenticated()
    // }
    await this.navigateToLoginForm()
    const authenticated = await this.runInWorker('checkAuthenticated')
    if (!authenticated) {
      this.log('info', 'Not authenticated')
      await this.showLoginFormAndWaitForAuthentication()
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
      return true
    }
    return true
  }

  onWorkerReady() {
    const button = document.querySelector('input[type=submit]')
    if (button) {
      button.addEventListener('click', () =>
        this.bridge.emit('workerEvent', 'loginSubmit')
      )
    }
    const error = document.querySelector('.error')
    if (error) {
      this.bridge.emit('workerEvent', 'loginError', { msg: error.innerHTML })
    }
  }

  async checkAuthenticated() {
    this.log('info', 'checkauthenticated starts')
    const passwordField = document.querySelector('#pass')
    const loginField = document.querySelector('#user')
    if (passwordField && loginField) {
      const userCredentials = await this.findAndSendCredentials.bind(this)(
        loginField,
        passwordField
      )
      this.log('info', `userCreds : ${JSON.stringify(userCredentials)}`)
      this.log('info', "Sending user's credentials to Pilot")
      this.sendToPilot({ userCredentials })
    }
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
    // We'll need a 2FA to reach the infos page, and for now the person who owns the account is not available for a 2FA
    this.log(
      'info',
      `store userCreds : ${JSON.stringify(this.store.userCredentials)}`
    )
    // await this.waitForElementInWorker('[pause]')
    // await this.runInWorker(
    //   'click',
    //   'a[href="/mon-espace-perso/vos-coordonnees/"]'
    // )
    // await Promise.race([
    //   this.waitForElementInWorker('#envoyerCodeForm'),
    //   this.waitForElementInWorker('')
    // ])
    return {
      sourceAccountIdentifier:
        'sourceAccountIdentifierToReplaceWhenUserDatatHasBeenScraped'
    }
  }

  async fetch(context) {
    this.log('info', '🤖 fetch')
    await this.goto(accountUrl)
    await this.waitForElementInWorker('#listeRemboursementsSante')
    await this.runInWorker(
      'click',
      'a[href="/mon-espace-perso/mes-remboursements/"]'
    )
    await Promise.all([
      this.waitForElementInWorker('#tableDernierRemboursement'),
      this.waitForElementInWorker('#sectionRechercheRemboursements'),
      this.waitForElementInWorker('ol')
    ])
    let hasNextPage = true
    let pageNumber = 1
    while (hasNextPage) {
      this.log('info', 'getting in while loop')
      const foundBillsLength = await this.evaluateInWorker(
        function getBillsLength() {
          return document.querySelectorAll('.ligne-remboursement').length
        }
      )
      for (let i = 0; i < foundBillsLength; i++) {
        this.log('info', `foundBillLength : ${foundBillsLength}`)
        const firstBillPart = await this.runInWorker('getFirstBillPart', i)
        if (firstBillPart === null) {
          this.log('info', 'No pdf to download for this file, jumping it')
          continue
        }
        // await this.waitForElementInWorker('[pause]')
        // After that we need to navigate to details page to determine if there is a thirdPartyPayer on this bill, info is not present in the first page
        await this.navigateToBillDetails(i)
        const secondBillPart = await this.runInWorker('getSecondBillPart')
        const oneBill = { ...firstBillPart, ...secondBillPart }
        // Save files before navigation
        this.log(
          'info',
          `oneBill before saveBills : ${JSON.stringify(oneBill)}`
        )
        await this.clickAndWait('.backLink', '#tableDernierRemboursement')
        if (pageNumber > 1) {
          this.log('info', `pageNumber is ${pageNumber}`)
          for (let j = 0; j < pageNumber - 1; j++) {
            await this.runInWorkerUntilTrue({ method: 'removeBillsElements' })
            await this.runInWorker(
              'click',
              '#tableDernierRemboursement_next > a'
            )
            await this.waitForElementInWorker('.ligne-remboursement')
          }
        }
        await this.saveBills([oneBill], {
          context,
          contentType: 'application/pdf',
          fileIdAttributes: ['vendorRef'],
          qualificationLabel: 'health_invoice'
        })
        if (i === foundBillsLength - 1) {
          this.log('info', 'last bill for this page')
          break
        }
      }
      hasNextPage = await this.runInWorker('checkNextPage')
      if (hasNextPage) {
        this.log('info', 'nextPage condition')
        // Removing all the bills element so we can wait for them when landing on the next bills page
        await this.runInWorkerUntilTrue({ method: 'removeBillsElements' })
        await this.runInWorker('click', '#tableDernierRemboursement_next > a')
        await this.waitForElementInWorker('.ligne-remboursement')
        pageNumber++
        // await this.waitForElementInWorker('[pause]')
      }
    }
  }

  async getFirstBillPart(i) {
    this.log('info', 'getFirstBillPart starts')
    const foundBillsElements = document.querySelectorAll('.ligne-remboursement')
    const innerHTMLForOneBill = []
    this.log('info', 'getFirstBillPart loop ' + i)
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
    let foundFilehref
    if (pdfInfos.match(/href="([^"]*)"/)) {
      foundFilehref = pdfInfos.match(/href="([^"]*)"/)[1]
    } else {
      return null
    }
    const filehref = decodeURIComponent(foundFilehref).replace(/&amp;/g, '&')
    const fileurl = `${baseUrl}${filehref}`
    const vendorRef = pdfInfos.match(/data-url-releve="([^"]*)"/)[1]
    const amountAndCurrency = foundAmount
      .replace(/\s/g, ' ')
      .split('<br>')[0]
      .trim()
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
    let searchParams = new FormData()
    formDataArray.forEach(item => {
      searchParams.set(item.inputName, item.inputValue)
    })
    searchParams.set('urlReleve', queryParams.urlReleve)
    searchParams.set('dattrait', queryParams.dattrait)
    searchParams.set('dateReleve', queryParams.dateReleve)
    const firstBillPart = {
      vendorRef,
      date: treatmentDate,
      treatmentDate,
      reimbursmentDate,
      beneficiary,
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
          datetime: parse(treatmentDate, 'dd/MM/yyyy', new Date()),
          datetimeLabel: 'issueDate',
          carbonCopy: true
        }
      }
    }
    const response = await ky
      .post(fileurl, {
        body: searchParams
      })
      .blob()

    firstBillPart.dataUri = await blobToBase64(response)
    return firstBillPart
  }

  async getSecondBillPart() {
    this.log('info', 'getSecondBillPart starts')
    const thirdPartyPayerElement = document.querySelector('.decomptePrice')
    const secondBillPart = {}
    if (thirdPartyPayerElement) {
      const foundThirdPartyPayer = thirdPartyPayerElement
        .querySelector('p')
        .textContent.replace(/\s/g, ' ')
        .trim()
      const foundAmount = foundThirdPartyPayer.match(/([\d, €]*)/)[0]
      secondBillPart.isThirdPartyPayer = true
      secondBillPart.thirdPartyRefund = parseFloat(
        foundAmount.replace(',', '.').split(' ')[0]
      )
      return secondBillPart
    } else {
      this.log('info', 'No thirdPartyPayer for this bill')
      return secondBillPart
    }
  }

  async navigateToBillDetails(i) {
    this.log('info', 'navigateToBillDetails starts')
    await this.runInWorker('clickBillDetails', i)
    await this.waitForElementInWorker('#sectionDetailsRemboursements')
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

  async removeBillsElements() {
    this.log('info', 'removeBillsElements starts')
    document.querySelectorAll('.ligne-remboursement').forEach(element => {
      element.remove()
    })
    await waitFor(
      () => {
        const elementsLength = document.querySelectorAll(
          '.ligne-remboursement'
        ).length
        if (elementsLength === 0) {
          return true
        }
        return false
      },
      {
        interval: 100,
        timeout: {
          milliseconds: 10000,
          message: new TimeoutError('removeBillsElements timed out after 10sec')
        }
      }
    )
    return true
  }

  clickBillDetails(i) {
    this.log('info', 'clickBillDetails starts')
    const elementToClick = document
      .querySelectorAll('.ligne-remboursement')
      [i].querySelector('a[aria-label*="Voir les détails"]')
    elementToClick.click()
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
}
const connector = new MgenContentScript()
connector
  .init({
    additionalExposedMethodsNames: [
      'getFirstBillPart',
      'getSecondBillPart',
      'checkNextPage',
      'removeBillsElements',
      'clickBillDetails'
    ]
  })
  .catch(err => {
    log.warn(err)
  })
