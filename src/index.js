// Doc about what to store for Banks:
// https://github.com/cozy/cozy-doctypes/blob/master/docs/io.cozy.bank.md

const {
  BaseKonnector,
  requestFactory,
  signin,
  scrape,
  log,
  updateOrCreate,
  cozyClient
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
const moment = require('moment')
const groupBy = require('lodash/groupBy')

const baseUrl = 'https://mabanque.fortuneo.fr'
const localizator = 'fr'
const identificationUrl = `${baseUrl}/${localizator}/identification.jsp`
const operationsUrl = `${baseUrl}/${localizator}/prive/mes-comptes/compte-courant/consulter-situation/consulter-solde.jsp`
const AccountTypeEnum = {
  UNKNOWN: 0,
  COMPTE_COURANT: 1,
  BOURSE: 2,
  ASSURANCE_VIE: 3,
  EPARGNE: 4
}

module.exports = new BaseKonnector(start)

// The start function is run by the BaseKonnector instance only when it got all the account
// information (fields). When you run this connector yourself in "standalone" mode or "dev" mode,
// the account information come from ./konnector-dev-config.json file
async function start(fields) {
  log('info', 'Authenticating ...')
  const $ = await authenticate(fields.login, fields.password)
  log('info', 'Fetching the accounts')
  let accounts = await parseAccounts($)
  log('info', 'Fetching the balances')
  await getAllBalances(accounts)
  log('info', 'Saving the accounts')
  const savedAccounts = await addOrUpdateAccounts(accounts)
  log('info', 'Saving the balances in balance history')
  await saveBalances(savedAccounts)
  log('info', 'Fetching the operations')
  accounts = await getAllOperations(accounts)
  log('info', 'Saving the operations')
  await saveAllOperations(accounts, savedAccounts)
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
  // You can find documentation about the scrape function here:
  // https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#scrape
  const accounts = scrape(
    $,
    {
      number: {
        sel: 'a.numero_compte',
        fn: $node =>
          $node
            .clone() // Clone the element
            .children() // Select all the children
            .remove() // Remove all the children
            .end() // Again go back to selected element
            .text() // Get text
            .slice(3) // Remove first 3 characters, i.e. 'N° '
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
  const accountPage = await request(`${baseUrl}${account.link}`)

  switch (account.type) {
    case AccountTypeEnum.COMPTE_COURANT:
      account.balance = scrape(
        accountPage('#tableauConsultationHisto>tbody>tr>td'),
        {
          value: {
            sel: 'strong',
            parse: cleanBalance
          }
        }
      ).value
      break

    case AccountTypeEnum.BOURSE:
      account.balance = scrape(
        accountPage('#valorisation_compte>table>tbody>tr'),
        {
          value: {
            sel: 'td.gras',
            parse: cleanBalance
          }
        }
      ).value
      break

    case AccountTypeEnum.ASSURANCE_VIE:
      account.balance = scrape(
        accountPage('div.synthese_vie>div>div.colonne_gauche>div>p>span'),
        {
          value: {
            sel: 'strong',
            parse: cleanBalance
          }
        }
      ).value
      break

    case AccountTypeEnum.EPARGNE:
      account.balance = scrape(
        accountPage(
          'div.synthese_livret_cat>div>div.colonne_gauche>div.arrow_line>a'
        ),
        {
          value: {
            sel: 'p.synthese_data_line_right_text',
            parse: cleanBalance
          }
        }
      ).value
      break

    default:
      log('warn', `Unable to retrieve balance of account type: ${account.type}`)
      break
  }
}

// Retrieve the balance of a list of accounts
async function getAllBalances(accounts) {
  for (let account of accounts) {
    await getBalance(account)
  }
}

// Save the accounts in Cozy, or update them if already present
async function addOrUpdateAccounts(accounts) {
  const cozyAccounts = []

  for (let account of accounts) {
    // Create Cozy accounts.
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

// Save the accounts balance in the balance histories of Cozy
async function saveBalances(accounts) {
  const now = moment()
  const todayAsString = now.format('YYYY-MM-DD')
  const currentYear = now.year()
  const balanceHistories = []

  for (let account of accounts) {
    const balanceHistory = await getBalanceHistory(currentYear, account._id)
    balanceHistory.balances[todayAsString] = account.balance
    balanceHistories.push(balanceHistory)
  }

  return updateOrCreate(balanceHistories, 'io.cozy.bank.balancehistories', [
    '_id'
  ])
}

// Retrieve the balance history for a year and an account.
// If none is found, create a new one.
async function getBalanceHistory(year, accountId) {
  // Options used to find the balance history
  const index = await cozyClient.data.defineIndex(
    'io.cozy.bank.balancehistories',
    ['year', 'relationships.account.data._id']
  )
  const options = {
    selector: {
      year,
      'relationships.account.data._id': accountId
    },
    limit: 1
  }
  const [balanceHistory] = await cozyClient.data.query(index, options)

  // Check if a balance history was found
  if (balanceHistory) {
    return balanceHistory
  }

  // Balance history not found, create a new one.
  // See https://github.com/cozy/cozy-doctypes/blob/master/docs/io.cozy.bank.md#iocozybankbalancehistories
  return {
    year,
    balances: {},
    metadata: {
      version: 1
    },
    relationships: {
      account: {
        data: {
          _id: accountId,
          _type: 'io.cozy.bank.accounts'
        }
      }
    }
  }
}

// Retrieve the operations of an account
async function getOperations(account) {
  let operations = []
  let operationsPage

  switch (account.type) {
    case AccountTypeEnum.COMPTE_COURANT:
    case AccountTypeEnum.EPARGNE:
      // First go to the account page, as it sets some internal variables
      await request(`${baseUrl}${account.link}`)
      // Then post the operations retrieval form
      operationsPage = await request(operationsUrl, {
        method: 'POST',
        form: {
          dateRechercheDebut: moment()
            .subtract(10, 'years')
            .format('D/MM/YYYY'),
          nbrEltsParPage: '100'
        }
      })
      operations = scrape(
        operationsPage,
        {
          operationDate: {
            sel: 'td:nth-of-type(2)',
            parse: normalizeDate
          },
          valueDate: {
            sel: 'td:nth-of-type(3)',
            parse: normalizeDate
          },
          label: {
            sel: 'td:nth-of-type(4)',
            fn: $node =>
              ($node.children().length ? $node.find('div') : $node) // Get child if necessary
                .text() // Get text
                .replace(/\n|\t/gm, '') // Trim text of extra characters
          },
          debit: {
            sel: 'td:nth-of-type(5)',
            parse: cleanAmount
          },
          credit: {
            sel: 'td:nth-of-type(6)',
            parse: cleanAmount
          }
        },
        '#tabHistoriqueOperations>tbody>tr'
      )
      break

    case AccountTypeEnum.BOURSE:
    case AccountTypeEnum.ASSURANCE_VIE:
      log(
        'info',
        `Operations retrieval not implemented for account type: ${account.type}`
      )
      break

    default:
      log(
        'warn',
        `Unable to retrieve operations of account type: ${account.type}`
      )
      break
  }

  return operations
}

// Retrieve the operations of list of accounts
async function getAllOperations(accounts) {
  for (let account of accounts) {
    account.operations = await getOperations(account)
  }

  return accounts
}

// Save the operations of an account
async function saveOperations(account, cozyAccount) {
  if (account.operations) {
    const cozyOperations = []

    for (let operation of account.operations) {
      // Create Cozy operations.
      // See https://github.com/cozy/cozy-doctypes/blob/master/docs/io.cozy.bank.md#iocozybankoperations
      const cozyOperation = {
        label: operation.label,
        type: 'none', // FixMe: Parse label to get the type?
        date: operation.valueDate.toISOString(),
        dateOperation: operation.operationDate.toISOString(),
        amount: isNaN(operation.credit) ? operation.debit : operation.credit,
        currency: 'EUR',
        account: cozyAccount._id,
        metadata: {
          dateImport: moment()
            .toDate()
            .toISOString(),
          version: 1
        }
      }
      cozyOperations.push(cozyOperation)
    }

    // Forge a vendorId which uniquely identifies the operation
    // by concatenating the account number, the date as YYYY-MM-DD
    // and the index of the operation during the day.
    const groups = groupBy(cozyOperations, x => x.date.slice(0, 10))
    Object.entries(groups).forEach(([date, group]) => {
      group.forEach((operation, i) => {
        operation.vendorId = `${cozyAccount.number}_${date}_${i}`
      })
    })

    updateOrCreate(cozyOperations, 'io.cozy.bank.operations', [
      'account',
      'amount',
      'date',
      'vendorId'
    ])
  }
}

// Save the operations of list of accounts
async function saveAllOperations(accounts, cozyAccounts) {
  for (let account of accounts) {
    // Find associated Cozy account
    const cozyAccount = cozyAccounts.find(function(element) {
      return element.number == account.number
    })
    if (!cozyAccount) {
      throw new Error(`Cozy account associated to ${account.number} not found!`)
    }
    // Save the operations
    saveOperations(account, cozyAccount)
  }
}

// Convert an enum type to a Cozy account type
function getAccountCozyType(type) {
  switch (type) {
    case AccountTypeEnum.COMPTE_COURANT:
      return 'Checkings'
    case AccountTypeEnum.BOURSE:
    case AccountTypeEnum.ASSURANCE_VIE:
    case AccountTypeEnum.EPARGNE:
      return 'Savings'
    default:
      throw new Error(`Unsupported type: ${type}`)
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

// Clean the operation amount string
function cleanAmount(string) {
  // Remove everything which is not a ',', a '+/-', or a digit
  string = string.replace(/[^0-9,\-+]/, '')
  // Replace ',' by '.'
  string = string.replace(',', '.')
  // Get the number from the string
  return parseFloat(string)
}

// Clean the account balance string
// Throw an error if this is not possible as it should not happen
function cleanBalance(string) {
  let balance = cleanAmount(string)
  if (isNaN(balance)) {
    throw new Error('Failed to parse the balance')
  }
  return balance
}

// Convert a date string to a date
function normalizeDate(date) {
  // String format: dd/mm/yyyy
  return new Date(
    date.slice(6, 10) + '-' + date.slice(3, 5) + '-' + date.slice(0, 2) + 'Z'
  )
}
