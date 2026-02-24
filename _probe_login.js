// Quick probe to see what the login page looks like
var puppeteer = require('puppeteer-core');

var BROWSER = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
var URL = 'https://ranjani-17668.csez.zohocorpin.com:4200';

puppeteer.launch({
  executablePath: BROWSER,
  headless: true,
  args: ['--ignore-certificate-errors', '--no-sandbox', '--disable-setuid-sandbox']
}).then(function (browser) {
  return browser.newPage().then(function (page) {
    console.log('Navigating to', URL);
    return page.goto(URL, { waitUntil: 'networkidle0', timeout: 30000 })
    .then(function () {
      console.log('After goto, URL is:', page.url());
      // Wait extra for redirects/JS rendering
      return new Promise(function (r) { setTimeout(r, 5000); });
    })
    .then(function () {
      console.log('After wait, URL is:', page.url());
      // Get page title
      return page.title();
    })
    .then(function (title) {
      console.log('Title:', title);
      // Get all inputs
      return page.$$eval('input', function (els) {
        return els.map(function (e) {
          return {
            tag: e.tagName,
            type: e.type,
            id: e.id,
            name: e.name,
            placeholder: e.placeholder,
            visible: e.offsetParent !== null,
            cls: e.className.substring(0, 60)
          };
        });
      });
    })
    .then(function (inputs) {
      console.log('Found', inputs.length, 'input elements:');
      console.log(JSON.stringify(inputs, null, 2));
      // Also check for iframes (some login pages use them)
      return page.$$eval('iframe', function (frames) {
        return frames.map(function (f) { return { src: f.src, id: f.id, name: f.name }; });
      });
    })
    .then(function (iframes) {
      if (iframes.length) console.log('Iframes:', JSON.stringify(iframes, null, 2));
      // Take a screenshot
      return page.screenshot({ path: 'd:/zoho-bug-track/_login_probe.png' });
    })
    .then(function () {
      console.log('Screenshot saved to _login_probe.png');
      return browser.close();
    });
  });
}).catch(function (err) {
  console.error('Error:', err.message);
  process.exit(1);
});
