const nodemailer = require('nodemailer');

async function sendEmail({ to, subject, text }) {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.example.com',
    port: Number(process.env.SMTP_PORT || 587),
    secure: false,
    auth: {
      user: process.env.SMTP_USER || '',
      pass: process.env.SMTP_PASS || ''
    }
  });

  await transporter.sendMail({
    from: process.env.EMAIL_FROM || 'hello@kieltech.com',
    to,
    subject,
    text
  });
}

module.exports = { sendEmail };
