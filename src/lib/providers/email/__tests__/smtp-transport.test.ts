import { beforeEach, describe, expect, it, vi } from 'vitest';

// The transport is resolved from the environment at module load, so each case
// re-imports sendMailCore under a fresh env. nodemailer is mocked to capture the
// options it is handed instead of opening a socket.
const sendMailSpy = vi.fn(async () => ({ messageId: 'msg-1' }));
const createTransportSpy = vi.fn((_opts: unknown) => ({ sendMail: sendMailSpy }));
vi.mock('nodemailer', () => ({
  default: { createTransport: (o: unknown) => createTransportSpy(o) },
  createTransport: (o: unknown) => createTransportSpy(o),
}));

const MAIL_VARS = [
  'SMTP_AWS_SES',
  'SMTP_GMAIL',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_SECURE',
  'SMTP_USER',
  'SMTP_PASS',
  'SMTP_FROM',
  'GMAIL_USER',
  'GMAIL_PASS',
  'AWS_REGION',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
];

const message = {
  fromName: 'Signals Support',
  fromEmail: 'no-reply@bluedots.example',
  to: 'asha@example.com',
  subject: 'Complaint received',
  html: '<p>details</p>',
};

/** Loads sendMailCore under `env` and sends one mail through it. */
async function send(env: Record<string, string>) {
  vi.resetModules();
  for (const key of MAIL_VARS) delete process.env[key];
  Object.assign(process.env, env);

  const { sendMail } = await import('../sendMailCore');
  const result = await sendMail(message);
  return {
    result,
    transport: createTransportSpy.mock.calls.at(-1)?.[0] as Record<string, unknown>,
    sent: sendMailSpy.mock.calls.at(-1)?.[0] as { from: string },
  };
}

const GMAIL_ENV = { SMTP_GMAIL: 'true', GMAIL_USER: 'relay@gmail.com', GMAIL_PASS: 'app-pw' };

beforeEach(() => {
  createTransportSpy.mockClear();
  sendMailSpy.mockClear();
});

describe('transport selection', () => {
  it('keeps the SMTP_GMAIL shorthand on smtp.gmail.com:465 with implicit TLS', async () => {
    const { transport } = await send(GMAIL_ENV);
    expect(transport).toEqual({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: 'relay@gmail.com', pass: 'app-pw' },
    });
  });

  it('dials an arbitrary host from SMTP_HOST, defaulting to 587 + STARTTLS', async () => {
    const { transport } = await send({
      SMTP_HOST: 'smtp.zoho.in',
      SMTP_USER: 'notify@bluedots.example',
      SMTP_PASS: 'zoho-pw',
    });
    expect(transport).toEqual({
      host: 'smtp.zoho.in',
      port: 587,
      secure: false,
      auth: { user: 'notify@bluedots.example', pass: 'zoho-pw' },
    });
  });

  it('lets SMTP_HOST win over the SMTP_GMAIL shorthand', async () => {
    const { transport } = await send({ ...GMAIL_ENV, SMTP_HOST: 'mail.internal.example' });
    expect(transport).toMatchObject({ host: 'mail.internal.example', port: 587 });
  });

  it('falls back to GMAIL_USER/GMAIL_PASS when the generic credentials are unset', async () => {
    // The whole point of keeping the old names: a values file that still ships
    // only GMAIL_* keeps authenticating after SMTP_HOST is introduced.
    const { transport } = await send({ ...GMAIL_ENV, SMTP_HOST: 'smtp.mailgun.org' });
    expect(transport).toMatchObject({ auth: { user: 'relay@gmail.com', pass: 'app-pw' } });
  });

  it('prefers SMTP_USER/SMTP_PASS over the Gmail-named fallbacks', async () => {
    const { transport } = await send({
      ...GMAIL_ENV,
      SMTP_HOST: 'smtp.mailgun.org',
      SMTP_USER: 'postmaster@mg.example',
      SMTP_PASS: 'mg-pw',
    });
    expect(transport).toMatchObject({ auth: { user: 'postmaster@mg.example', pass: 'mg-pw' } });
  });

  it('omits auth entirely for an unauthenticated relay', async () => {
    const { transport } = await send({ SMTP_HOST: 'localhost', SMTP_PORT: '1025' });
    expect(transport).toEqual({ host: 'localhost', port: 1025, secure: false });
    expect(transport).not.toHaveProperty('auth');
  });

  it('still routes through SES when SMTP_AWS_SES wins, even with SMTP_HOST set', async () => {
    const { transport } = await send({
      SMTP_AWS_SES: 'true',
      SMTP_HOST: 'smtp.zoho.in',
      AWS_REGION: 'ap-south-1',
      AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
      AWS_SECRET_ACCESS_KEY: 'secret',
    });
    expect(transport).toHaveProperty('SES');
  });

  it('names the variables it wanted when nothing is configured', async () => {
    await expect(send({})).rejects.toThrow(/SMTP_HOST/);
    await expect(send({})).rejects.toThrow(/SMTP_GMAIL/);
    await expect(send({})).rejects.toThrow(/SMTP_AWS_SES/);
  });
});

describe('secure flag', () => {
  it.each([
    ['465', true],
    ['587', false],
    ['2525', false],
  ])('derives secure from port %s as %s', async (SMTP_PORT, expected) => {
    const { transport } = await send({ SMTP_HOST: 'smtp.example.com', SMTP_PORT });
    expect(transport).toMatchObject({ secure: expected });
  });

  it.each([
    ['true', true],
    ['TRUE', true],
    ['false', false],
  ])('lets SMTP_SECURE=%s override the port-derived default', async (SMTP_SECURE, expected) => {
    const { transport } = await send({ SMTP_HOST: 'smtp.example.com', SMTP_SECURE });
    expect(transport).toMatchObject({ secure: expected });
  });

  it('treats an empty SMTP_SECURE as unset, so the Gmail shorthand keeps implicit TLS', async () => {
    // The chart renders an unset value as "", and reading that as `false` would
    // leave the shorthand on 465 with no TLS — a connection that never completes.
    const { transport } = await send({ ...GMAIL_ENV, SMTP_SECURE: '' });
    expect(transport).toMatchObject({ port: 465, secure: true });
  });
});

describe('From address', () => {
  it('overrides the caller with the authenticated account on Gmail', async () => {
    // Gmail rewrites or rejects a From that is not the authenticated mailbox.
    const { sent } = await send(GMAIL_ENV);
    expect(sent.from).toBe('Signals Support <relay@gmail.com>');
  });

  it('keeps the caller-supplied address on a generic relay', async () => {
    // A relay username is often not a mailbox at all (postmaster@mg.…, AKIA…),
    // so it must not leak into the From header.
    const { sent } = await send({
      SMTP_HOST: 'smtp.mailgun.org',
      SMTP_USER: 'postmaster@mg.example',
      SMTP_PASS: 'mg-pw',
    });
    expect(sent.from).toBe('Signals Support <no-reply@bluedots.example>');
  });

  it('uses SMTP_FROM when the relay requires a fixed sender', async () => {
    const { sent } = await send({
      SMTP_HOST: 'smtp.zoho.in',
      SMTP_USER: 'notify@bluedots.example',
      SMTP_PASS: 'zoho-pw',
      SMTP_FROM: 'noreply@bluedots.example',
    });
    expect(sent.from).toBe('Signals Support <noreply@bluedots.example>');
  });

  it('lets SMTP_FROM override the Gmail account too', async () => {
    const { sent } = await send({ ...GMAIL_ENV, SMTP_FROM: 'alerts@bluedots.example' });
    expect(sent.from).toBe('Signals Support <alerts@bluedots.example>');
  });

  it('leaves the caller address alone under SES', async () => {
    const { sent } = await send({
      SMTP_AWS_SES: 'true',
      AWS_REGION: 'ap-south-1',
      AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
      AWS_SECRET_ACCESS_KEY: 'secret',
    });
    expect(sent.from).toBe('Signals Support <no-reply@bluedots.example>');
  });
});
