/**
 * Splitter — the one identity check the Worker can make on its own.
 *
 * A member's id is a hash of a secret the browser made and never shares; the secret travels once,
 * in the first frame of a socket, so the server can confirm that the id presented is the id the
 * secret derives. The label is wire format: it is the same `sp1:member:` label crypto.js uses, and
 * a known-answer test holds the two copies together.
 */

const LABEL = 'sp1:member:';
const ID_BYTES = 16;
const encoder = new TextEncoder();

function toBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * The member id a secret names, or null when the input cannot name one.
 *
 * Null rather than an exception: this runs on a frame from the network, and the caller's answer to
 * a malformed value is the same as its answer to a wrong one — close the socket.
 *
 * @param {unknown} secret
 * @returns {Promise<string | null>}
 */
export async function memberIdFromSecret(secret) {
  if (typeof secret !== 'string' || secret === '') return null;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(`${LABEL}${secret}`)));
  return toBase64Url(digest.slice(0, ID_BYTES));
}
