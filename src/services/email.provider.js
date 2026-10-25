'use strict';

const net = require('net');
const tls = require('tls');
const { env } = require('../config/env');
const logger = require('../config/logger');

/**
 * Email delivery. Same shape as the SMS provider: a console mock for
 * development and a real transport for deployment.
 *
 * The SMTP path speaks just enough of the protocol to send one plain-text
 * message, which avoids adding nodemailer for a single call. If you need
 * attachments, HTML alternatives or DKIM, replace `sendViaSmtp` with nodemailer
 * and keep the exported `sendEmail` signature.
 */

async function sendViaMock({ to, subject, text }) {
  logger.warn('--------------------------------------------------------');
  logger.warn(`[MOCK EMAIL] to: ${to}`);
  logger.warn(`[MOCK EMAIL] subject: ${subject}`);
  logger.warn(`[MOCK EMAIL] ${text}`);
  logger.warn('--------------------------------------------------------');
  return { mocked: true };
}

/** Reads SMTP reply lines until one without a continuation dash arrives. */
function readReply(socket) {
  return new Promise((resolve, reject) => {
    let buffer = '';

    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/).filter(Boolean);
      const last = lines[lines.length - 1];
      // A final reply line is "250 text"; a continuation is "250-text".
      if (last && /^\d{3} /.test(last)) {
        cleanup();
        const code = Number.parseInt(last.slice(0, 3), 10);
        resolve({ code, text: buffer.trim() });
      }
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('SMTP server closed the connection unexpectedly.'));
    };
    function cleanup() {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    }

    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
  });
}

async function command(socket, line, expectedCodes) {
  if (line !== null) socket.write(`${line}\r\n`);
  const reply = await readReply(socket);
  if (expectedCodes && !expectedCodes.includes(reply.code)) {
    throw new Error(`SMTP command failed (${line || 'greeting'}): ${reply.text}`);
  }
  return reply;
}

async function sendViaSmtp({ to, subject, text }) {
  const { smtpHost, smtpPort, smtpUser, smtpPassword, from } = env.email;
  if (!smtpHost || !smtpUser || !smtpPassword) {
    throw new Error('EMAIL_PROVIDER=smtp but SMTP_HOST / SMTP_USER / SMTP_PASSWORD are not all set.');
  }

  // Port 465 is implicit TLS; 587 and 25 start plain and upgrade via STARTTLS.
  const implicitTls = smtpPort === 465;
  let socket = implicitTls
    ? tls.connect({ host: smtpHost, port: smtpPort, servername: smtpHost })
    : net.connect({ host: smtpHost, port: smtpPort });

  socket.setTimeout(15000);
  socket.on('timeout', () => socket.destroy(new Error('SMTP connection timed out.')));

  await new Promise((resolve, reject) => {
    socket.once(implicitTls ? 'secureConnect' : 'connect', resolve);
    socket.once('error', reject);
  });

  try {
    await command(socket, null, [220]);
    await command(socket, `EHLO ${smtpHost}`, [250]);

    if (!implicitTls) {
      await command(socket, 'STARTTLS', [220]);
      socket = tls.connect({ socket, servername: smtpHost });
      await new Promise((resolve, reject) => {
        socket.once('secureConnect', resolve);
        socket.once('error', reject);
      });
      await command(socket, `EHLO ${smtpHost}`, [250]);
    }

    const credentials = Buffer.from(`\0${smtpUser}\0${smtpPassword}`).toString('base64');
    await command(socket, `AUTH PLAIN ${credentials}`, [235]);

    // Envelope sender must be the bare address, not the display-name form.
    const fromAddress = /<([^>]+)>/.exec(from)?.[1] || from;
    await command(socket, `MAIL FROM:<${fromAddress}>`, [250]);
    await command(socket, `RCPT TO:<${to}>`, [250, 251]);
    await command(socket, 'DATA', [354]);

    const headers = [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      `Date: ${new Date().toUTCString()}`,
    ].join('\r\n');
    // Dot-stuffing: a line that is just "." would otherwise end the message.
    const safeBody = text.replace(/\r?\n\./g, '\r\n..');
    await command(socket, `${headers}\r\n\r\n${safeBody}\r\n.`, [250]);

    await command(socket, 'QUIT', [221]).catch(() => {});
    return { mocked: false };
  } finally {
    socket.end();
    socket.destroy();
  }
}

async function sendEmail({ to, subject, text }) {
  switch (env.email.provider) {
    case 'smtp':
      return sendViaSmtp({ to, subject, text });
    case 'mock':
      return sendViaMock({ to, subject, text });
    default:
      throw new Error(`Unknown EMAIL_PROVIDER "${env.email.provider}". Use "mock" or "smtp".`);
  }
}

const isMocked = () => env.email.provider === 'mock';

module.exports = { sendEmail, isMocked };
