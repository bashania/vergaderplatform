// Software-authenticator voor tests: doet wat een telefoon of laptop doet bij een passkey
// (sleutelpaar maken, uitdaging ondertekenen), zodat de API-test de hele keten kan doorlopen
// zonder browser. Alleen voor tests; niet gebruiken als echte authenticator.
import { createHash, createSign, generateKeyPairSync, randomBytes } from "node:crypto";

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const sha256 = (data) => createHash("sha256").update(data).digest();

// ---------- minimale CBOR-codering (genoeg voor WebAuthn) ----------

function head(major, n) {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
  throw new Error("cbor: te lang");
}

function cbor(value) {
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") {
    const b = Buffer.from(value, "utf8");
    return Buffer.concat([head(3, b.length), b]);
  }
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (value instanceof Map) return Buffer.concat([head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)])]);
  throw new Error("cbor: type niet ondersteund");
}

const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;
const FLAG_ATTESTED_DATA = 0x40;

export class SoftAuthenticator {
  /** origin: het adres zoals de browser het ziet, bijvoorbeeld http://localhost:8888 */
  constructor(origin) {
    this.origin = origin;
    this.rpId = new URL(origin).hostname;
    this.credentials = new Map();
  }

  clientData(type, challenge) {
    return Buffer.from(JSON.stringify({ type, challenge, origin: this.origin, crossOrigin: false }));
  }

  /** navigator.credentials.create(): maakt een passkey aan. */
  create(options) {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" });
    const credentialId = randomBytes(32);
    // COSE-sleutel: EC2, ES256, P-256.
    const cose = cbor(
      new Map([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x, "base64url")],
        [-3, Buffer.from(jwk.y, "base64url")],
      ]),
    );
    const authData = Buffer.concat([
      sha256(this.rpId),
      Buffer.from([FLAG_USER_PRESENT | FLAG_USER_VERIFIED | FLAG_ATTESTED_DATA]),
      Buffer.alloc(4), // teller
      Buffer.alloc(16), // aaguid
      Buffer.from([credentialId.length >> 8, credentialId.length & 255]),
      credentialId,
      cose,
    ]);
    const attestationObject = cbor(
      new Map([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData],
      ]),
    );
    const id = b64u(credentialId);
    this.credentials.set(id, { privateKey, userHandle: options.user.id, counter: 0 });
    return {
      id,
      rawId: id,
      type: "public-key",
      authenticatorAttachment: "platform",
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64u(this.clientData("webauthn.create", options.challenge)),
        attestationObject: b64u(attestationObject),
        transports: ["internal"],
      },
    };
  }

  /** navigator.credentials.get(): logt in met een eerder aangemaakte passkey. */
  get(options, credentialId = [...this.credentials.keys()].at(-1)) {
    const cred = this.credentials.get(credentialId);
    if (!cred) throw new Error("onbekende passkey");
    cred.counter += 1;
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(cred.counter);
    const authData = Buffer.concat([sha256(this.rpId), Buffer.from([FLAG_USER_PRESENT | FLAG_USER_VERIFIED]), counter]);
    const clientDataJSON = this.clientData("webauthn.get", options.challenge);
    const signature = createSign("SHA256")
      .update(Buffer.concat([authData, sha256(clientDataJSON)]))
      .sign(cred.privateKey);
    return {
      id: credentialId,
      rawId: credentialId,
      type: "public-key",
      authenticatorAttachment: "platform",
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64u(clientDataJSON),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
        userHandle: cred.userHandle,
      },
    };
  }
}
