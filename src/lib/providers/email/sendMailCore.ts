import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import nodemailer from 'nodemailer';
import SMTPTransport from 'nodemailer/lib/smtp-transport';

let transporter: nodemailer.Transporter<SMTPTransport.SentMessageInfo>;

export interface Email_attachment {
  filename: string;
  contentType: string;
  /** Base64-encoded content, no `data:` prefix. */
  data: string;
}

interface Email_request {
  fromName: string;
  fromEmail: string;
  replyTo?: string;
  to: string;
  subject: string;
  html: string;
  activationUrl?: string;
  cc?: string;
  attachments?: Email_attachment[];
}

const {
  MAIL_LOG,
  SMTP_AWS_SES,
  SMTP_GMAIL,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_SECURE,
  SMTP_USER,
  SMTP_PASS,
  SMTP_FROM,
  AWS_REGION,
  AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY,
  GMAIL_USER,
  GMAIL_PASS,
} = process.env;

const isTrue = (v?: string) => String(v).toLowerCase() === 'true';

/** The endpoint the `SMTP_GMAIL=true` shorthand expands into. */
const GMAIL = { host: 'smtp.gmail.com', port: 465 };

/**
 * The SMTP connection, resolved from the environment.
 *
 * `SMTP_HOST` is the real knob and wins whenever it is set — that is what makes
 * Zoho / Mailgun / a corporate relay a values change rather than a code change,
 * matching how the aggregator reads SMTP_HOST/PORT/SECURE (#112).
 *
 * `SMTP_GMAIL=true` is kept as a shorthand for the Gmail endpoint so existing
 * deployments, which set only that flag plus GMAIL_USER/GMAIL_PASS, keep
 * dialling smtp.gmail.com:465 with implicit TLS exactly as before.
 */
function resolveSmtp(): { options: SMTPTransport.Options; user?: string } | undefined {
  const host = SMTP_HOST || (isTrue(SMTP_GMAIL) ? GMAIL.host : undefined);
  if (!host) return undefined;

  // 587 + STARTTLS is the common default among third-party providers, so an
  // unset port must NOT assume 465. The Gmail shorthand keeps its own 465.
  const port = Number(SMTP_PORT) || (SMTP_HOST ? 587 : GMAIL.port);
  // `secure` means implicit TLS from the first byte, which is port 465. On 587
  // the session opens plaintext and upgrades via STARTTLS, which nodemailer
  // does on its own — so derive it from the port unless it is stated outright.
  // The empty string counts as unset: the chart renders an unset value as "",
  // and reading that as `false` would break the Gmail shorthand's 465.
  const secure = SMTP_SECURE ? isTrue(SMTP_SECURE) : port === 465;
  const user = SMTP_USER || GMAIL_USER;
  const pass = SMTP_PASS || GMAIL_PASS;

  return {
    options: {
      host,
      port,
      secure,
      // An open relay (a local MTA, a dev mailcatcher) has no credentials, and
      // an `auth` object with undefined members still makes nodemailer attempt
      // AUTH and fail. Only send it when there is something to send.
      ...(user && pass ? { auth: { user, pass } } : {}),
    },
    user,
  };
}

const smtp = resolveSmtp();
const useSes = isTrue(SMTP_AWS_SES);

/**
 * The address the envelope is sent from, or `undefined` to use the caller's
 * `fromEmail`.
 *
 * Gmail rewrites (or rejects) a From that is not the authenticated account, so
 * the Gmail path has always had to override the caller — that is what the old
 * `SMTP_GMAIL === 'true' ? GMAIL_USER : fromEmail` ternary was for. A generic
 * relay does not have that constraint and its SMTP username is often not even a
 * mailbox (`AKIA…`, `postmaster@mg.…`), so it keeps the caller's address unless
 * `SMTP_FROM` names one explicitly.
 */
const envelopeFrom = useSes
  ? undefined
  : SMTP_FROM || (smtp?.options.host === GMAIL.host ? smtp.user : undefined);

async function initTransporter() {
  if (transporter) return;

  if (useSes) {
    try {
      const sesClient = new SESv2Client({
        region: AWS_REGION!,
        credentials: {
          accessKeyId: AWS_ACCESS_KEY_ID!,
          secretAccessKey: AWS_SECRET_ACCESS_KEY!,
        },
      });

      transporter = nodemailer.createTransport({
        SES: { sesClient, SendEmailCommand },
      });
    } catch (err) {
      console.log('AWS TRANSPORTER ERROR: ', err);
    }
  } else if (smtp) {
    try {
      transporter = nodemailer.createTransport(smtp.options);
    } catch (err) {
      console.log('SMTP TRANSPORTER ERROR: ', err);
    }
  } else {
    // Thrown on the first send, long after the misconfigured deploy went out,
    // so it names what is missing rather than just saying no.
    throw new Error(
      'No valid mail transport configuration found. Set SMTP_HOST (with SMTP_PORT/SMTP_SECURE ' +
        'and SMTP_USER/SMTP_PASS), or SMTP_GMAIL=true with GMAIL_USER/GMAIL_PASS, or ' +
        'SMTP_AWS_SES=true with AWS_REGION and AWS credentials.'
    );
  }
}

export async function sendMail({
  fromName,
  fromEmail,
  replyTo,
  to,
  subject,
  html,
  activationUrl,
  cc,
  attachments,
}: Email_request): Promise<{ ok: boolean }> {
  if (MAIL_LOG === 'true') {
    console.log('📧 Sending mail to:', to);
    if (activationUrl) console.log('🔗 Activation URL/OTP:', activationUrl);
    // Names and sizes only — never the base64 content, which would dump
    // megabytes of a user's file into the service logs.
    if (attachments?.length) {
      console.log(
        '📎 Attachments:',
        attachments.map((a) => `${a.filename} (${a.contentType}, ${a.data.length}B base64)`).join(', ')
      );
    }
  }

  await initTransporter();

  try {
    const result = await transporter.sendMail({
      from: `${fromName} <${envelopeFrom ?? fromEmail}>`,
      to,
      replyTo,
      cc,
      subject,
      // The plain-text alternative. The trailing `<`-strip is not redundant: the
      // tag regex is a single pass, so an UNTERMINATED tag leaves its `<` behind
      // ("<p>x<script" -> "x<script") — CodeQL
      // js/incomplete-multi-character-sanitization. Nothing executes in a
      // text/plain part, so this was never exploitable, but removing any residual
      // `<` makes a surviving `<script` impossible for one linear pass.
      //
      // Only `<` is stripped, deliberately NOT `>`. A blanket /[<>]/ also deletes
      // legitimate unescaped `>` from visible copy — "Score > 90" became
      // "Score  90" and "A => B" became "A = B" — which silently corrupts the
      // plain-text body of ordinary mail. See the mailer test.
      text: html.replace(/<[^>]+>/g, '').replace(/</g, ''),
      html,
      // Decoded here rather than passing `encoding: 'base64'` so nodemailer
      // handles the transfer encoding itself for whatever transport is active
      // (the SES transport re-encodes into raw MIME).
      ...(attachments?.length
        ? {
            attachments: attachments.map((a) => ({
              filename: a.filename,
              content: Buffer.from(a.data, 'base64'),
              contentType: a.contentType,
            })),
          }
        : {}),
    });

    if (MAIL_LOG === 'true') {
      console.log('✅ Email sent:', result.messageId);
    }

    return { ok: true };
  } catch (err) {
    console.error('❌ Email sending error:', err);
    return { ok: false };
  }
}
