// ponytail: Math.random ids. crypto.randomUUID exists only in secure contexts, and a share link opened over plain http
// on the LAN is not one, so every id and the auth salt come from here
export const randomId = () => Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('')
