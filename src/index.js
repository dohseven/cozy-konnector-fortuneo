const {
  BaseKonnector,
  requestFactory,
  signin,
  scrape,
  saveBills,
  log
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

module.exports = new BaseKonnector(start)

// The start function is run by the BaseKonnector instance only when it got all the account
// information (fields). When you run this connector yourself in "standalone" mode or "dev" mode,
// the account information come from ./konnector-dev-config.json file
async function start(fields) {
  log('info', 'Authenticating ...')
  const $ = await authenticate(fields.login, fields.password)
  log('info', 'Fetching the accounts')
  const accounts = await parseAccounts($)
  for (let account of accounts) {
    log('info', account)
  }
}

// Authentication using the [signin function](https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#module_signin)
function authenticate(login, password) {
  return signin({
    url: identificationUrl,
    formSelector: 'form[name="acces_identification"]',
    formData: { login: login, passwd: password },
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
        sel: '.numero_compte',
        fn: $node => $node.clone()      // Clone the element
                          .children()   // Select all the children
                          .remove()     // Remove all the children
                          .end()        // Again go back to selected element
                          .text()       // Get text
                          .slice(3)     // Remove first 3 characters, i.e. 'N° '
      },
      type: {
        sel: 'a>span'
      },
      link: {
        sel: 'a',
        attr: 'href'
      }
    },
    '#menu_mes_comptes>.slide_wrapper>ul>li>div'
  )

  return accounts
}
