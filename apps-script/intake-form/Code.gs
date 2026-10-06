/**
 * @OnlyCurrentDoc
 */

/*
 * Pivot Point Recovery -- intake notifications.
 *
 * (@OnlyCurrentDoc above limits the script to this one form, rather than every
 * form of whoever installs it.)
 *
 * Lives on the "Pivot Point Recovery — Clinical Intake" Google Form, the one
 * pivotpointrecovery.org/contact links to. On every submission it tells the
 * website, which adds a reference to the Board Center's intake queue and emails
 * the staff notification list: the same people who hear about contact and
 * volunteer forms.
 *
 * What leaves Google is the form's id, the response's id and the time it was
 * submitted. Never an answer. The answers are protected under 42 CFR Part 2 and
 * stay in this form and its responses sheet.
 *
 * Set up once, by someone who can edit the form (README, "Intake form"):
 *   1. In the form: three-dot menu -> Apps Script. Replace the contents of
 *      Code.gs with this file and save.
 *   2. Pick `setup` in the toolbar and Run. Approve the permissions. The
 *      execution log prints a secret.
 *   3. Supabase dashboard -> Edge Functions -> Secrets: add
 *      INTAKE_WEBHOOK_SECRET with that value.
 *   4. Run `sendTest`. Everyone on the notification list gets a test email.
 *
 * Whoever runs setup owns the trigger. If the website ever cannot be reached,
 * the fallback email goes to them, through Google's own mail.
 */

const ENDPOINT = 'https://ihgwhglatsbhngbsezuj.supabase.co/functions/v1/intake-webhook';
const SECRET_PROPERTY = 'INTAKE_WEBHOOK_SECRET';
const HANDLER = 'onIntakeSubmit';
const TIME_ZONE = 'America/New_York';

/** Installs the submit trigger and makes the shared secret. Safe to re-run:
 *  it replaces its own trigger rather than adding a second, and keeps the
 *  secret it already made. */
function setup() {
  const form = FormApp.getActiveForm();

  // Two triggers would mean two runs per intake. The website would still send
  // one email -- it recognises a repeat -- but there is no reason to ask twice.
  ScriptApp.getProjectTriggers()
    .filter((trigger) => trigger.getHandlerFunction() === HANDLER)
    .forEach((trigger) => ScriptApp.deleteTrigger(trigger));
  ScriptApp.newTrigger(HANDLER).forForm(form).onFormSubmit().create();

  const properties = PropertiesService.getScriptProperties();
  let secret = properties.getProperty(SECRET_PROPERTY);
  if (!secret) {
    secret = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
    properties.setProperty(SECRET_PROPERTY, secret);
  }

  console.log([
    'Intake notifications are installed on "' + form.getTitle() + '".',
    '',
    'If you have not done it already: Supabase dashboard → Edge Functions → Secrets →',
    'Add new secret, for project ihgwhglatsbhngbsezuj.',
    '  Name:  ' + SECRET_PROPERTY,
    '  Value: ' + secret,
    '',
    'Then run sendTest. Everyone on the notification list should get a test email.',
  ].join('\n'));
}

/** Sends the notification list a test email through the same path a real
 *  intake takes, without adding anything to the queue. */
function sendTest() {
  const result = post_({ test: true, form_id: FormApp.getActiveForm().getId() });
  if (!result.ok) throw new Error('The website refused the test: ' + result.error);
  if (!result.notified) {
    throw new Error('Connected, but the email did not send: ' + (result.reason || 'no reason given'));
  }
  console.log('Test email sent to ' + result.recipients + ' people on the notification list.');
}

/** Runs on every submission, via the trigger setup() installs. */
function onIntakeSubmit(e) {
  if (!e || !e.response) {
    throw new Error('The form runs this when someone submits it. To install it, run setup instead.');
  }

  const intake = {
    form_id: e.source.getId(),
    response_id: e.response.getId(),
    submitted_at: e.response.getTimestamp().toISOString(),
  };

  const result = post_(intake);
  if (result.ok && result.notified) return;

  // Staff were not told through the website. Tell the trigger's owner through
  // Google's own mail, then fail the run so it shows red under Executions.
  alertOwner_(intake, result);
  throw new Error('Intake ' + (result.ref || intake.response_id) + ' did not notify staff: ' +
    (result.error || result.reason || 'no reason given'));
}

/** POSTs to the website. Never throws: every outcome comes back as an object
 *  with `ok`, and a server error or a dropped connection is retried twice. */
function post_(body) {
  const secret = PropertiesService.getScriptProperties().getProperty(SECRET_PROPERTY);
  if (!secret) return { ok: false, error: 'no secret in Script Properties -- run setup first' };

  let error = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = UrlFetchApp.fetch(ENDPOINT, {
        method: 'post',
        contentType: 'application/json',
        headers: { 'X-Intake-Secret': secret },
        payload: JSON.stringify(body),
        muteHttpExceptions: true,
      });
      const status = response.getResponseCode();
      let data = {};
      try {
        data = JSON.parse(response.getContentText());
      } catch (ignored) {
        // Not JSON -- a gateway error page, most likely. The status says enough.
      }
      if (status >= 200 && status < 300) return data;

      error = 'HTTP ' + status + (data.error ? ': ' + data.error : '');
      // A refused secret or a malformed request will not change on a retry.
      if (status < 500) break;
    } catch (err) {
      error = String((err && err.message) || err);
    }
    if (attempt < 3) Utilities.sleep(attempt * 3000);
  }
  return { ok: false, error: error };
}

/** The fallback: a plain email to whoever installed the trigger. Carries a
 *  link to the response, never its contents. */
function alertOwner_(intake, result) {
  const owner = Session.getEffectiveUser().getEmail();
  if (!owner) return;

  const when = Utilities.formatDate(new Date(intake.submitted_at), TIME_ZONE, 'EEE, MMM d, yyyy h:mm a z');
  const link = 'https://docs.google.com/forms/d/' + intake.form_id + '/edit#response=' + intake.response_id;
  const what = result.ok
    ? 'It is in the Board Center intake queue as ' + result.ref + ', but the email to staff did not go out (' +
      (result.reason || 'no reason given') + ').'
    : 'The website could not be told, so the usual email did not go out and the intake is not in the ' +
      'Board Center queue (' + result.error + ').';

  MailApp.sendEmail({
    to: owner,
    subject: '[PPR] New intake — staff were NOT notified',
    body: [
      'Someone completed the intake form at ' + when + '.',
      '',
      what,
      '',
      'Open the response: ' + link,
      '',
      'Please make sure someone follows up within 1–2 business days, as the form promises.',
    ].join('\n'),
  });
}
