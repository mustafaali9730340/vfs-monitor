// check.js
import { chromium } from 'playwright';
import nodemailer from 'nodemailer';

const MONITOR_CONFIG_JSON = process.env.MONITOR_CONFIG_JSON || '[]';
let MONITORS;
try { MONITORS = JSON.parse(MONITOR_CONFIG_JSON); }
catch(e){ console.error('MONITOR_CONFIG_JSON parse error', e); process.exit(1); }

const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;

// Helper: send email
async function sendEmail(subject, text) {
  if (!EMAIL_USER || !EMAIL_PASS) {
    console.log('Email credentials not provided. Skipping email.');
    return;
  }
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: EMAIL_USER, pass: EMAIL_PASS }
  });
  await transporter.sendMail({
    from: `"VFS Notifier" <${EMAIL_USER}>`,
    to: EMAIL_USER,
    subject,
    text
  });
  console.log('Notification email sent to', EMAIL_USER);
}

// Decide if a monitor is due based on frequencyMinutes.
// We'll align on epoch minute: run when (currentMinute % frequency) === 0
function isDue(frequencyMinutes) {
  const nowMin = Math.floor(Date.now() / 60000);
  return (nowMin % frequencyMinutes) === 0;
}

async function checkSingle(m) {
  // m fields (example expected):
  // { id, vfsLoginUrl, centerValue, visaTypeValue, frequencyMinutes, usernameEnvKey, passwordEnvKey }
  const username = process.env[m.usernameEnvKey];
  const password = process.env[m.passwordEnvKey];
  if (!username || !password) {
    console.log(`[${m.id}] Missing username/password env keys ${m.usernameEnvKey}/${m.passwordEnvKey}`);
    return;
  }
  console.log(`[${m.id}] Starting check (center=${m.centerValue} visa=${m.visaTypeValue})`);

  const browser = await chromium.launch({ args: ['--no-sandbox'], headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // 1) Login page
    await page.goto(m.vfsLoginUrl, { waitUntil: 'networkidle' });
    // NOTE: Update selectors below if VFS page changes.
    // On the VFS login page for Norway Pakistan form, typical selectors:
    // - email input: input[name="email"] or input#email or input[name="username"]
    // - password input: input[name="password"]
    // - login button: button[type="submit"]
    // Replace selectors below if they don't match.
    // --- LOGIN ---
    // Wait and fill email
    await page.waitForSelector('input[type="email"], input[name="email"], input#email, input[name="username"]', { timeout: 10000 });
    // choose first that exists:
    const emailSelector = await page.$('input[type="email"]') ? 'input[type="email"]'
        : (await page.$('input[name="email"]') ? 'input[name="email"]' : (await page.$('input#email') ? 'input#email' : 'input[name="username"]'));
    const passSelector = await page.$('input[type="password"]') ? 'input[type="password"]' : 'input[name="password"]';

    await page.fill(emailSelector, username);
    await page.fill(passSelector, password);
    // Press submit
    const submitBtn = await page.$('button[type="submit"], button:has-text("Sign in"), button:has-text("Sign In")');
    if (submitBtn) await submitBtn.click();
    else {
      // fallback: press Enter on password
      await page.press(passSelector, 'Enter');
    }

    await page.waitForLoadState('networkidle');

    // Now we are at dashboard. Click "Start New Booking"
    // The page may use a button or link with text "Start New Booking"
    await page.waitForTimeout(2000);
    const startBtn = await page.$('text="Start New Booking", button:has-text("Start New Booking"), a:has-text("Start New Booking")');
    if (startBtn) {
      await startBtn.click();
    } else {
      // try alternative selector by search:
      const alt = await page.$('button:has-text("New Booking"), text="Start New Booking"');
      if (alt) await alt.click();
      else console.log('Start New Booking button not found — try adjusting selector in script.');
    }

    await page.waitForTimeout(2000);

    // Now we assume there's a center select dropdown and a visa type dropdown.
    // Replace these selectors with actual ones if needed.
    // Try to find select elements:
    // - For center: select[name="center"] or select#center or a list of radio buttons
    // - For visa type: select[name="visaType"], select#visaType

    // Attempt to set center if select exists
    const centerSelect = (await page.$('select[name="centre"], select[name="centreId"], select[name="center"], select#center, select[name="location"]'));
    if (centerSelect) {
      // set the value to configured centerValue
      try {
        await page.selectOption(await centerSelect.evaluate(node => node.getAttribute('name') ? `select[name="${node.getAttribute('name')}"]` : null), { label: m.centerValue });
      } catch (e) {
        // fallback: try set by value if provided in config
        try { await page.selectOption(await centerSelect.evaluate(n => n), { value: m.centerOptionValue || '' }); } catch {}
      }
    } else {
      console.log('Center select not found. May need special handling (radio buttons or custom dropdown).');
    }

    // For visa type:
    const visaSelect = (await page.$('select[name="visaType"], select[name="visa_type"], select#visaType, select[name="service"]'));
    if (visaSelect) {
      try {
        await page.selectOption(await visaSelect.evaluate(node => node.getAttribute('name') ? `select[name="${node.getAttribute('name')}"]` : null), { label: m.visaTypeValue });
      } catch (e) {
        // ignore
      }
    } else {
      console.log('Visa type select not found; may be custom UI.');
    }

    // Click Next/Continue to view availability
    const nextBtn = await page.$('button:has-text("Next"), button:has-text("Continue"), button:has-text("Proceed"), button:has-text("Check Availability")');
    if (nextBtn) { await nextBtn.click(); }
    await page.waitForTimeout(3000);

    // Now check page content for availability text
    const bodyText = await page.textContent('body');

    // Patterns to detect no slots vs slots. You may adjust these exact phrases as you observe site.
    const noSlotPattern = /no appointment slots are currently available|no appointments available|no slots available/i;
    const availablePattern = /appointments available|slots available|next available appointment|choose a slot/i;

    if (availablePattern.test(bodyText) && !noSlotPattern.test(bodyText)) {
      const message = `SLOT FOUND for ${m.id} (${m.centerValue} - ${m.visaTypeValue})\nLogin: ${m.vfsLoginUrl}`;
      console.log('*** SLOT FOUND ***', message);
      await sendEmail(`VFS Slot Found — ${m.id}`, message);
    } else {
      console.log(`[${m.id}] No slots found (checked).`);
    }

  } catch (err) {
    console.error(`[${m.id}] Error during check:`, err);
  } finally {
    await browser.close();
  }
}

(async () => {
  console.log('VFS Monitor run — checking monitors due now');
  const now = Date.now();
  for (const m of MONITORS) {
    // default frequency
    const freq = parseInt(m.frequencyMinutes || 15, 10);
    if (isNaN(freq) || freq < 5) {
      console.log(`[${m.id}] Invalid frequency ${m.frequencyMinutes}, skipping`);
      continue;
    }
    if (isDue(freq)) {
      await checkSingle(m);
    } else {
      console.log(`[${m.id}] not due (frequency ${freq} min) — skipping`);
    }
  }
  console.log('All monitors processed. Exiting.');
})();
