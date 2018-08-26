// Doc about what to store for Banks:
// https://github.com/cozy/cozy-doctypes/blob/master/docs/io.cozy.bank.md

const {
  BaseKonnector,
  requestFactory,
  signin,
  scrape,
  saveBills,
  log,
  errors,
  updateOrCreate
} = require('cozy-konnector-libs')

const request = requestFactory({
  // The debug mode shows all the details about HTTP requests and responses. Very useful for
  // debugging but very verbose. This is why it is set to false by default
  debug: false,
  // Activates [cheerio](https://cheerio.js.org/) parsing on each page
  cheerio: true,
  // If cheerio is activated do not forget to deactivate json parsing (which is activated by
  // default in cozy-konnector-libs
  json: false,
  // This allows request-promise to keep cookies between requests
  jar: true
})

const baseUrl = 'https://mabanque.fortuneo.fr'
const localizator = 'fr'
const identificationUrl = `${baseUrl}/${localizator}/identification.jsp`
const AccountTypeEnum = {
  UNKNOWN:        0,
  COMPTE_COURANT: 1,
  BOURSE:         2,
  ASSURANCE_VIE:  3,
  EPARGNE:        4
}

module.exports = new BaseKonnector(start)

// The start function is run by the BaseKonnector instance only when it got all the account
// information (fields). When you run this connector yourself in "standalone" mode or "dev" mode,
// the account information come from ./konnector-dev-config.json file
async function start(fields) {
  log('info', 'Authenticating ...')
  const $ = await authenticate(fields.login, fields.password)
  log('info', 'Fetching the accounts')
  const accounts = await parseAccounts($)
  log('info', 'Fetching the balances')
  for (let account of accounts) {
    await getBalance(account)
    log('info', account)
  }
  await addOrUpdateAccounts(accounts)
}

// Authentication using the [signin function](https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#module_signin)
function authenticate(login, password) {
  return signin({
    url: identificationUrl,
    formSelector: 'form[name="acces_identification"]',
    formData: { login: login, passwd: password },
    encoding: 'latin1',
    // The validate function will check if a logout link exists
    validate: (statusCode, $) => {
      if ($(`a[href='/logoff']`).length === 1) {
        log('info', 'Successfully logged in')
        return true
      } else {
        return false
      }
    }
  })
}

// This function retrieves all the accounts of the user.
function parseAccounts($) {
  // You can find documentation about the scrape function here :
  // https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#scrape
  const accounts = scrape(
    $,
    {
      number: {
        sel: 'a.numero_compte',
        fn: $node => $node.clone()      // Clone the element
                          .children()   // Select all the children
                          .remove()     // Remove all the children
                          .end()        // Again go back to selected element
                          .text()       // Get text
                          .slice(3)     // Remove first 3 characters, i.e. 'N° '
      },
      label: {
        sel: 'span'
      },
      type: {
        attr: 'class',
        parse: getAccountType
      },
      link: {
        sel: 'a',
        attr: 'href'
      }
    },
    '#menu_mes_comptes>div.slide_wrapper>ul>li>div'
  )

  return accounts
}

// Retrieve the balance of an account
async function getBalance(account) {
  const accountPage = await request(`${baseUrl}` + account.link)

  switch (account.type) {
    case AccountTypeEnum.COMPTE_COURANT:
      account.balance = scrape(
        accountPage('#tableauConsultationHisto>tbody>tr>td'),
        {
          value: {
            sel: 'strong',
            parse: cleanBalance
          }
        }).value
      break;

    case AccountTypeEnum.BOURSE:
      account.balance = scrape(
        accountPage('#valorisation_compte>table>tbody>tr'),
        {
          value: {
            sel: 'td.gras',
            parse: cleanBalance
          }
        }).value
      break;

    case AccountTypeEnum.ASSURANCE_VIE:
      account.balance = scrape(
        accountPage('div.synthese_vie>div>div.colonne_gauche>div>p>span'),
        {
          value: {
            sel: 'strong',
            parse: cleanBalance
          }
        }).value
      break;

    case AccountTypeEnum.EPARGNE:
      account.balance = scrape(
        accountPage('div.synthese_livret_cat>div>div.colonne_gauche>div.arrow_line>a'),
        {
          value: {
            sel: 'p.synthese_data_line_right_text',
            parse: cleanBalance
          }
        }).value
      break;

    default:
      log('warn', 'Unable to retrieve balance of account type ' + account.type)
      break;
  }
}

async function addOrUpdateAccounts(accounts) {
  const cozyAccounts = []
  for (let account of accounts) {
    // See https://github.com/cozy/cozy-doctypes/blob/master/docs/io.cozy.bank.md#iocozybankaccounts
    const cozyAccount = {
      label: account.label,
      institutionLabel: 'Fortuneo Banque',
      balance: account.balance,
      type: getAccountCozyType(account.type),
      number: account.number,
      metadata: {
        version: 1
      }
    }
    cozyAccounts.push(cozyAccount)
  }

  return updateOrCreate(cozyAccounts, 'io.cozy.bank.accounts', ['number'])
}

//
// Parser helpers
//

function getAccountCozyType(type) {
  switch (type) {
    case AccountTypeEnum.COMPTE_COURANT:
      return 'Checkings'
    case AccountTypeEnum.BOURSE:
    case AccountTypeEnum.ASSURANCE_VIE:
    case AccountTypeEnum.EPARGNE:
      return 'Savings'
    default:
      throw new Error('Unsupported type ' + type)
  }
}

// Get the account type from a string
function getAccountType(string) {
  // Keep only the first class: e.g. 'cco compte' -> 'cco'
  switch (string.replace(/\s+compte$/, '')) {
    case 'cco':
    case 'esp':
      return AccountTypeEnum.COMPTE_COURANT

    case 'ord':
    case 'pea':
      return AccountTypeEnum.BOURSE

    case 'vie':
      return AccountTypeEnum.ASSURANCE_VIE

    case 'liv_a':
    case 'liv_d':
      return AccountTypeEnum.EPARGNE

    default:
      return AccountTypeEnum.UNKNOWN
  }
}

// Clean the account balance string
function cleanBalance(string) {
  // Remove everything which is not a ',' or a digit
  string = string.replace(/[^0-9.]/, '')
  // Replace ',' by '.'
  string = string.replace(',','.')
  // Get the number from the string
  let balance = parseFloat(string)
  if (isNaN(balance)) {
    throw new Error('Failed to parse the balance')
  }
  return balance
}
