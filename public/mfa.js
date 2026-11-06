export async function listMfaFactors(api, accessToken) {
  if (!accessToken) throw new Error('Sign in before managing multi-factor authentication.');
  const user = await api('/auth/v1/user', { t: accessToken });
  return Array.isArray(user.factors) ? user.factors : [];
}
