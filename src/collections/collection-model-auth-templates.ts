// Upstream: core/collection_model_auth_templates.go
//
// The default templates are plain data here; setDefaultAuthOptions copies
// them into EmailTemplate values (Go copies the struct values).

// Common settings placeholder tokens
export const EmailPlaceholderAppName = "{APP_NAME}";
export const EmailPlaceholderAppURL = "{APP_URL}";
export const EmailPlaceholderToken = "{TOKEN}";
export const EmailPlaceholderOTP = "{OTP}";
export const EmailPlaceholderOTPId = "{OTP_ID}";
export const EmailPlaceholderAlertInfo = "{ALERT_INFO}";

export interface EmailTemplateData {
  readonly subject: string;
  readonly body: string;
}

export const defaultVerificationTemplate: EmailTemplateData = Object.freeze({
  subject: "Verify your " + EmailPlaceholderAppName + " email",
  body:
    `<p>Hello,</p>
<p>Thank you for joining us at ` +
    EmailPlaceholderAppName +
    `.</p>
<p>Click on the button below to verify your email address.</p>
<p>
  <a class="btn" href="` +
    EmailPlaceholderAppURL +
    "/_/#/auth/confirm-verification/" +
    EmailPlaceholderToken +
    `" target="_blank" rel="noopener">Verify</a>
</p>
<p><i>If you didn't recently register, please ignore this email.</i></p>
<p>
  Thanks,<br/>
  ` +
    EmailPlaceholderAppName +
    ` team
</p>`,
});

export const defaultResetPasswordTemplate: EmailTemplateData = Object.freeze({
  subject: "Reset your " + EmailPlaceholderAppName + " password",
  body:
    `<p>Hello,</p>
<p>Click on the button below to reset your password.</p>
<p>
  <a class="btn" href="` +
    EmailPlaceholderAppURL +
    "/_/#/auth/confirm-password-reset/" +
    EmailPlaceholderToken +
    `" target="_blank" rel="noopener">Reset password</a>
</p>
<p><i>If you didn't ask to reset your password, please ignore this email.</i></p>
<p>
  Thanks,<br/>
  ` +
    EmailPlaceholderAppName +
    ` team
</p>`,
});

export const defaultConfirmEmailChangeTemplate: EmailTemplateData = Object.freeze({
  subject: "Confirm your " + EmailPlaceholderAppName + " new email address",
  body:
    `<p>Hello,</p>
<p>Click on the button below to confirm your new email address.</p>
<p>
  <a class="btn" href="` +
    EmailPlaceholderAppURL +
    "/_/#/auth/confirm-email-change/" +
    EmailPlaceholderToken +
    `" target="_blank" rel="noopener">Confirm new email</a>
</p>
<p><i>If you didn't ask to change your email address, please ignore this email.</i></p>
<p>
  Thanks,<br/>
  ` +
    EmailPlaceholderAppName +
    ` team
</p>`,
});

export const defaultOTPTemplate: EmailTemplateData = Object.freeze({
  subject: "OTP for " + EmailPlaceholderAppName,
  body:
    `<p>Hello,</p>
<p>Your one-time password is: <strong>` +
    EmailPlaceholderOTP +
    `</strong></p>
<p><i>If you didn't ask for the one-time password, you can ignore this email.</i></p>
<p>
  Thanks,<br/>
  ` +
    EmailPlaceholderAppName +
    ` team
</p>`,
});

export const defaultAuthAlertTemplate: EmailTemplateData = Object.freeze({
  subject: "Login from a new location",
  body:
    `<p>Hello,</p>
<p>We noticed a login to your ` +
    EmailPlaceholderAppName +
    ` account from a new location:</p>
<p><em>` +
    EmailPlaceholderAlertInfo +
    `</em></p>
<p><strong>If this wasn't you, you should immediately change your ` +
    EmailPlaceholderAppName +
    ` account password to revoke access from all other locations.</strong></p>
<p>If this was you, you may disregard this email.</p>
<p>
  Thanks,<br/>
  ` +
    EmailPlaceholderAppName +
    ` team
</p>`,
});
