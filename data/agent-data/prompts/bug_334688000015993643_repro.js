// Auto-generated reproduction script for Bug: Test Bug - SOAR - Connections - Search Placeholder is different
// Generated: 2026-02-26T10:07:50.478Z
// Uses puppeteer-core with local Chrome/Edge — Node 8+ compatible
var puppeteer = require("C:/Users/kumar-23998/Downloads/zoho-bug-track/zoho-bug-track/data/agent-data/node_modules/puppeteer-core");

var BROWSER_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
var BASE_URL = "https://kumar-23998.csez.zohocorpin.com:4200/";
var TARGET_ROUTE = "/settings/integrations/connections";  // Route to navigate after login
var SCREENSHOT = "C:/Users/kumar-23998/Downloads/zoho-bug-track/zoho-bug-track/data/agent-data/prompts/bug_334688000015993643_screenshot.png";

function run() {
  var result = { passed: false, errors: [], assertions: [], title: "", pageUrl: "", navigationOk: false };
  var browser;

  return puppeteer.launch({
    executablePath: BROWSER_PATH,
    headless: true,
    args: ["--ignore-certificate-errors", "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
  }).then(function (b) {
    browser = b;
    return browser.newPage();
  }).then(function (page) {
    // Capture JS errors on the page
    page.on("pageerror", function (err) { result.errors.push(err.message || String(err)); });
    page.on("error", function (err) { result.errors.push(err.message || String(err)); });

    // ── Step 1: Login ──
    // Use networkidle2 (allows 2 outstanding connections) — SSO pages keep background requests alive
    return page.goto(BASE_URL, { waitUntil: "networkidle2", timeout: 60000 })
    .then(function () {
      // Page may redirect to SSO/login — wait for it to settle
      return new Promise(function (r) { setTimeout(r, 3000); });
    })
    .then(function () {
      // Take a debug screenshot to see what the login page looks like
      return page.screenshot({ path: SCREENSHOT.replace(".png", "_login_debug.png") }).catch(function () {});
    })
    .then(function () {
      // Log current URL (may have redirected to SSO)
      console.log("Login page URL: " + page.url());
      // Wait for the Zoho SSO login field specifically (id=login_id)
      // Do NOT use generic "input" with visible:true — the SSO page has many hidden inputs
      // that confuse Puppeteer visibility checks
      var loginSelectors = [
        "#login_id",
        "#userid",
        "input[name=LOGIN_ID]",
        "input[name=login_id]",
        "input[type=email]",
        "input[type=text]:not([style*=\"display: none\"])"
      ];
      // Poll for any of these selectors to appear (check every 500ms, up to 30s)
      var attempts = 0;
      var maxAttempts = 60;
      function pollForLogin() {
        function trySelector(i) {
          if (i >= loginSelectors.length) return Promise.resolve(null);
          return page.$(loginSelectors[i]).then(function (el) {
            if (el) return { el: el, selector: loginSelectors[i] };
            return trySelector(i + 1);
          });
        }
        return trySelector(0).then(function (found) {
          if (found) return found;
          attempts++;
          if (attempts >= maxAttempts) return null;
          return new Promise(function (r) { setTimeout(r, 500); }).then(pollForLogin);
        });
      }
      return pollForLogin();
    })
    .then(function (found) {
      if (!found) {
        // Dump all input elements for debugging
        return page.$$eval("input", function (inputs) {
          return inputs.map(function (i) {
            var rect = i.getBoundingClientRect();
            return { id: i.id, name: i.name, type: i.type, class: i.className,
              visible: rect.width > 0 && rect.height > 0,
              display: window.getComputedStyle(i).display,
              visibility: window.getComputedStyle(i).visibility };
          });
        }).then(function (info) {
          console.log("All inputs on page: " + JSON.stringify(info, null, 2));
          throw new Error("Could not find login field after 30s. URL: " + page.url());
        });
      }
      console.log("Found username field: " + found.selector);
      return found.el.click({ clickCount: 3 }).then(function () {
        return page.keyboard.type("agnelvd.a+soar+bv1@zohotest.com");
      });
    })
    .then(function () {
      // Look for submit/next button and click it
      var btnSelectors = ["#nextbtn", "button[type=submit]", "input[type=submit]", "button[id*=next]", "button[id*=login]", ".btn-primary", "button.login"];
      function findBtn(i) {
        if (i >= btnSelectors.length) return Promise.resolve(null);
        return page.$(btnSelectors[i]).then(function (el) {
          if (el) { console.log("Found submit button: " + btnSelectors[i]); return el; }
          return findBtn(i + 1);
        });
      }
      return findBtn(0);
    })
    .then(function (submitBtn) {
      if (!submitBtn) {
        console.log("No submit button found, pressing Enter instead");
        return page.keyboard.press("Enter");
      }
      return submitBtn.click();
    })
    .then(function () {
      // Wait for page to transition (password step or dashboard)
      return new Promise(function (r) { setTimeout(r, 4000); });
    })
    .then(function () {
      // Check if password field appeared (two-step login) — poll for it
      return page.waitForSelector("#password, input[type=password]", { timeout: 10000 }).catch(function () { return null; });
    })
    .then(function (pwEl) {
      if (!pwEl) {
        // Try one more direct check
        return page.$("#password").then(function (el) {
          if (el) return el;
          return page.$("input[type=password]");
        });
      }
      return pwEl;
    })
    .then(function (pwEl) {
      if (!pwEl) {
        console.log("No password field found — may already be logged in or single-step login");
        return;
      }
      console.log("Password field found — filling password");
      return pwEl.click({ clickCount: 3 })
        .then(function () { return page.keyboard.type("teSt@246"); })
        .then(function () {
          // Find and click sign-in button
          var btnSelectors = ["#nextbtn", "button[type=submit]", "input[type=submit]", "button[id*=next]", "button[id*=sign]", ".btn-primary"];
          function findBtn2(i) {
            if (i >= btnSelectors.length) return Promise.resolve(null);
            return page.$(btnSelectors[i]).then(function (el) { return el || findBtn2(i + 1); });
          }
          return findBtn2(0);
        })
        .then(function (btn) {
          if (!btn) return page.keyboard.press("Enter");
          return btn.click();
        })
        .then(function () {
          // Wait for post-login navigation
          return page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(function () {});
        });
    })
    .then(function () {
      console.log("Post-login URL: " + page.url());
      return new Promise(function (r) { setTimeout(r, 3000); });  // let app initialize
    })
    .then(function () {
      // ── Step 2: Navigate to bug's page ──
      if (TARGET_ROUTE) {
        var targetUrl = BASE_URL.replace(/\/+$/, "") + "/#" + TARGET_ROUTE;
        console.log("Navigating to target route: " + targetUrl);
        return page.goto(targetUrl, { waitUntil: "networkidle2", timeout: 30000 })
          .then(function () {
            return new Promise(function (r) { setTimeout(r, 5000); });
          })
          .then(function () {
            var currentUrl = page.url();
            console.log("On target page: " + currentUrl);
            var routeSegments = TARGET_ROUTE.replace(/^\//, "").split("/");
            var lastSeg = routeSegments[routeSegments.length - 1] || "";
            if (currentUrl.indexOf(lastSeg) !== -1) {
              result.navigationOk = true;
              console.log("\u2705 Navigation verified");
            } else {
              return page.evaluate(function () { return window.location.hash; }).then(function (hash) {
                console.log("URL hash: " + hash);
                if (hash && hash.indexOf(lastSeg) !== -1) {
                  result.navigationOk = true;
                  console.log("\u2705 Navigation OK via hash");
                } else {
                  result.navigationOk = false;
                  console.log("\u26a0\ufe0f Navigation may have failed");
                  console.log("   Expected: " + lastSeg + " | URL: " + currentUrl + " | Hash: " + hash);
                }
              });
            }
          })
          .then(function () {
            return page.screenshot({ path: SCREENSHOT.replace(".png", "_route_debug.png") }).catch(function () {});
          });
      } else {
        result.navigationOk = true;
        console.log("No target route \u2014 staying on current page: " + page.url());
        return Promise.resolve();
      }
    })
    .then(function () {
      // ── Step 3: AI-generated interaction steps (4 steps) ──
      console.log("Executing " + "4" + " AI-generated interaction steps...");
      var interactionErrors = [];
      return Promise.resolve()
      .then(function () {
        console.log("  Step 1/4: Wait for the Connections page header to load");
        return page.waitForSelector(".fw-page-header.subtext h1", { timeout: 10000 }).catch(function (e) {
          console.log("    ⚠ Wait failed: " + e.message);
          interactionErrors.push("Step 1 wait failed: " + e.message);
        });
      })
      .then(function () { return new Promise(function (r) { setTimeout(r, 500); }); })
      .then(function () {
        console.log("  Step 2/4: Wait for the search input field to appear, indicating services data has been fetched");
        return page.waitForSelector(".application-search input.form-control", { timeout: 10000 }).catch(function (e) {
          console.log("    ⚠ Wait failed: " + e.message);
          interactionErrors.push("Step 2 wait failed: " + e.message);
        });
      })
      .then(function () { return new Promise(function (r) { setTimeout(r, 500); }); })
      .then(function () {
        console.log("  Step 3/4: Capture the search input placeholder text to visually confirm the bug");
        return page.screenshot({ path: SCREENSHOT.replace(".png", "_connections_search_placeholder.png") }).catch(function () {});
      })
      .then(function () { return new Promise(function (r) { setTimeout(r, 500); }); })
      .then(function () {
        console.log("  Step 4/4: Bug: The search placeholder says \'Search Service\' instead of the correct \'Search Services\'");
        return page.$(".application-search input.form-control").then(function (el) {
          if (!el) {
            console.log("    ⚠ Assert element not found: .application-search input.form-control");
            result.assertions.push({ step: 4, status: "element-not-found", selector: ".application-search input.form-control" });
            return;
          }
          return page.evaluate(function (el, attr) { return (el.getAttribute(attr) || "").trim(); }, el, "placeholder").then(function (actual) {
            console.log("    Assert: placeholder = '" + actual + "'");
            var matched = actual.toLowerCase() === "search service";
            result.assertions.push({
              step: 4,
              attribute: "placeholder",
              expected: "Search Service",
              actual: actual,
              matched: matched,
              description: "Bug: The search placeholder says \\'Search Service\\' instead of the correct \\'Search Services\\'"
            });
            if (matched) {
              console.log("    ✅ ASSERT MATCHED — bug condition confirmed");
            } else {
              console.log("    ❌ ASSERT DID NOT MATCH — expected Search Service but got " + actual);
            }
          });
        }).catch(function (e) {
          console.log("    ⚠ Assert failed: " + e.message);
          interactionErrors.push("Step 4 assert failed: " + e.message);
        });
      })
      .then(function () {
        console.log("Interaction steps complete. Errors: " + interactionErrors.length);
        if (interactionErrors.length > 0) {
          interactionErrors.forEach(function (e) { result.errors.push(e); });
        }
        // Wait for any async UI updates after interactions
        return new Promise(function (r) { setTimeout(r, 2000); });
      });
    })
    .then(function () {
      // Bug: The search placeholder in connections page is different.<br/>It should be &quot;Search Services&quot;<br/>But currently it is &quot;Search Service&quot;
      result.pageUrl = page.url();
      return page.title();
    })
    .then(function (t) {
      result.title = t;
      // Wait a bit for any late errors
      return new Promise(function (r) { setTimeout(r, 2000); });
    })
    .then(function () {
      return page.screenshot({ path: SCREENSHOT }).catch(function () {});
    })
    .then(function () {
      // Determine result based on assertions + errors
      var bugAssertions = result.assertions.filter(function (a) { return a.matched; });
      if (bugAssertions.length > 0) {
        // At least one assertion confirmed the buggy behavior
        result.passed = false;
        result.bugConfirmed = true;
        console.log("BUG CONFIRMED by " + bugAssertions.length + " assertion(s)");
      } else if (result.assertions.length > 0) {
        // Assertions ran but none matched bug condition
        result.passed = true;
        result.bugConfirmed = false;
        console.log("Assertions ran but bug condition NOT found");
      } else {
        // No assertions — rely on error count
        result.passed = result.errors.length === 0;
        result.bugConfirmed = false;
        if (!result.navigationOk) {
          result.passed = false;
          console.log("Test FAILED due to navigation failure");
        }
      }
      return browser.close();
    })
    .then(function () { return result; });
  });
}

run().then(function (r) {
  // Output result as JSON on a tagged line so the runner can parse it
  console.log("__REPRO_RESULT__" + JSON.stringify(r));
  process.exit(r.passed ? 0 : 1);
}).catch(function (e) {
  console.error("Reproduction error:", e.message || e);
  console.log("__REPRO_RESULT__" + JSON.stringify({ passed: false, errors: [e.message || String(e)] }));
  process.exit(1);
});
