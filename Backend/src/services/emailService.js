import nodemailer from 'nodemailer';

let transporter;

function getMailConfig() {
    const host = process.env.SMTP_HOST?.trim();
    const port = Number(process.env.SMTP_PORT || 587);
    const user = process.env.SMTP_USER?.trim();
    const pass = process.env.SMTP_PASS;
    const from = process.env.SMTP_FROM?.trim() || user;
    if (!host || !Number.isInteger(port) || !user || !pass || !from) {
        throw new Error('Password reset email is not configured. Contact the barangay administrator.');
    }
    return {
        transport: {
            host,
            port,
            secure: process.env.SMTP_SECURE === 'true' || port === 465,
            auth: { user, pass },
        },
        from,
    };
}

function getTransporter() {
    if (!transporter) transporter = nodemailer.createTransport(getMailConfig().transport);
    return transporter;
}

function assertEmailDeliveryConfigured() {
    getMailConfig();
}

function escapeHtml(value) {
    return String(value || '').replace(/[&<>'"]/g, (character) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
    })[character]);
}

async function sendPasswordResetEmail({ email, name, code, expiresAt }) {
    const { from } = getMailConfig();
    const displayCode = code.match(/.{1,4}/g)?.join('-') || code;
    const expiryText = new Intl.DateTimeFormat('en-PH', {
        dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Manila',
    }).format(expiresAt);
    await getTransporter().sendMail({
        from,
        to: email,
        subject: 'Your TrashQuest password reset code',
        text: `Hello ${name || 'TrashQuest resident'},\n\nYour password reset code is ${displayCode}. It expires at ${expiryText} (Asia/Manila) and can be used only once.\n\nIf you did not request this reset, you can ignore this email.`,
        html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#17372b"><h2>Reset your TrashQuest password</h2><p>Hello ${escapeHtml(name || 'TrashQuest resident')},</p><p>Enter this one-time code on the TrashQuest Forgot Password screen:</p><p style="font-size:26px;font-weight:800;letter-spacing:4px;padding:16px;background:#edf8f1;border-radius:10px;text-align:center">${escapeHtml(displayCode)}</p><p>This code expires at <strong>${escapeHtml(expiryText)} (Asia/Manila)</strong> and can be used only once.</p><p style="color:#61756b">If you did not request this reset, you can safely ignore this email.</p></div>`,
    });
}

export { assertEmailDeliveryConfigured, sendPasswordResetEmail };
