export function fault(code, message) {
  return Object.assign(new Error(message), { code, statusCode: code });
}

export function publicErrorMessage(error) {
  return String(error?.message || "应用服务错误")
    .replace(/\b(?:sk|rt)\.[A-Za-z0-9._-]{12,}\b/gi, "[凭据已隐藏]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/gi, "[凭据已隐藏]")
    .replace(/(?:Bearer\s+)[A-Za-z0-9._~-]{12,}/gi, "Bearer [凭据已隐藏]");
}
