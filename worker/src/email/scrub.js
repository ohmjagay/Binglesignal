function luhnValid(value) {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index--) {
    let digit = Number(digits[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function maskCards(value) {
  return value.replace(/\b(?:\d[ -]?){13,19}\b/g, (candidate) =>
    luhnValid(candidate) ? '[CARD]' : candidate);
}

export function scrubSensitiveText(input) {
  return maskCards(String(input))
    .replace(/\b(?:otp|one[- ]time(?: password| code)?|verification code|security code|pin)\b(?:\s*(?:is|:|=|-)?\s*)\d{4,8}\b/gi, '[CODE]')
    .replace(/\b\d{4}(?:[ -]?\d{4}){2}\b/g, '[AADHAAR]')
    .replace(/\b[A-Z]{5}\d{4}[A-Z]\b/gi, '[PAN]')
    .replace(/\b[A-Z]{4}0[A-Z0-9]{6}\b/gi, '[IFSC]')
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[SSN]')
    .replace(/\b(?:password|pwd|passcode)\b\s*(?:is|:|=|-)?\s*\S+/gi, '[SECRET]')
    .replace(/\b(?:sk_[A-Za-z0-9_-]{12,}|AKIA[A-Z0-9]{16}|ghp_[A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, '[SECRET]')
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, '[LINK]')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}
