// -----------------------------------------------------------------------------
// Self-signed certificate for the local HTTPS server the client tests spin up.
//
// This is a TEST FIXTURE, not a credential: it is issued for `localhost`, its
// private key is deliberately public, and nothing outside `test/` ever loads
// it. Regenerate it with:
//
//   openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem \
//     -days 36500 -nodes -subj "/CN=localhost" \
//     -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
//   openssl x509 -in cert.pem -noout -fingerprint -sha256
// -----------------------------------------------------------------------------

export const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIDJzCCAg+gAwIBAgIULKh7fFps+pWuXxL1eV+9KavKZI8wDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MDgxOTA3MzM0M1oYDzIxMjYw
NzI2MDczMzQzWjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEB
AQUAA4IBDwAwggEKAoIBAQDKWzAb/Ssti5hea8JKETy0pf4creWns3kTXYzkHZTF
C23hMNRKuzF5QbJjY0Itg3+Fctbvw8RoTCjxrfSY00M+kJbbFqgY/FQ3p1C4/TD/
47XB7lUx2UNbK0rnnruDcPRJ+Q6XlW0FTU7s5rUB0aSnjbeZTPT4lc14IMhs5aJZ
PqNMEtPRUdp/XGcX2OUpcm7LO8Ig7NjRhAC2bBrhENg2a1DzUAgRg3UoXXLNLRlU
k1+BDykUpF+zFIXRrSfyv8buvpNB2fr8oKfSwIXljD+B47eFK5KBGv+mmQx697M8
xbpCtzbWt7ELBCNXmgnVMVAjh+dqPPX8148kSFnQW+rTAgMBAAGjbzBtMB0GA1Ud
DgQWBBRVDmyOLcKWUcDyS2HDQd/pnVoltjAfBgNVHSMEGDAWgBRVDmyOLcKWUcDy
S2HDQd/pnVoltjAPBgNVHRMBAf8EBTADAQH/MBoGA1UdEQQTMBGCCWxvY2FsaG9z
dIcEfwAAATANBgkqhkiG9w0BAQsFAAOCAQEAN5pBPwTqpqKdUxB319dymUBm/6T8
GU9bIWYnTIo60tb4Bmhh4Q3FIH9/CcxKhK1VxztBxXc7UPZ4sTxGVEZtMpzGX0Cq
LvLXoCjGaeiV2lqt+Xcw2xhm2pQL43mmVGuNr17bEbrM6TmsROqw6jI231egY5Lk
6mFUhkL1AHxe1qsNzVIo1jOTAfZjCmO6qbP/szf3e78/zAidrGwdewEoDWVOv8Xk
jJ4VLB3vsUNnMAZn300Uo3OKNbJVgtBZrQFuXq1nCWKB0yImnT2ZY6BmuKuUODj6
GHLrTx8jbfjy3MlGQ+u+SS1pDyrf9matAj+xQoxdUoE1AG4thMzNZHbk9A==
-----END CERTIFICATE-----`;

export const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSlAgEAAoIBAQDKWzAb/Ssti5he
a8JKETy0pf4creWns3kTXYzkHZTFC23hMNRKuzF5QbJjY0Itg3+Fctbvw8RoTCjx
rfSY00M+kJbbFqgY/FQ3p1C4/TD/47XB7lUx2UNbK0rnnruDcPRJ+Q6XlW0FTU7s
5rUB0aSnjbeZTPT4lc14IMhs5aJZPqNMEtPRUdp/XGcX2OUpcm7LO8Ig7NjRhAC2
bBrhENg2a1DzUAgRg3UoXXLNLRlUk1+BDykUpF+zFIXRrSfyv8buvpNB2fr8oKfS
wIXljD+B47eFK5KBGv+mmQx697M8xbpCtzbWt7ELBCNXmgnVMVAjh+dqPPX8148k
SFnQW+rTAgMBAAECggEAAXarYGhyWX/6+CPbYeHCCKRytA5l7NKVe5hfnn7ARrSQ
dOJ/hpLYBsJ84c8j+WRMFdEA0PcfgomaejUB4eEVSWyOSsNdL+ETUtu4772VDyS8
ecyZfSTPIeesQQSa4pZ8jdRpUJtaEIHAomIAySSVBkk2HLu7wdiDhezmxjLa+74+
7SWPvaQfNezfSgMsnjYbk2wo44uczfpJhWhgdR7Uq/6F0VhLKgDac7Pv/BzxnruO
rc7OkgK6bjyI2YTztve8l2vbW0Tnu+VHOPP8rkXwI+OH/VDniVD+fzHP/MlF6xGU
m1uh5jw3bFyLggiOQYdUjaogwe2dqIKvKuP65XM9QQKBgQD7PwSAZRAgusiHxSvg
P0B0KPQhv9TG99YbkrxgpYFP6l6DL7FGBAh6oiY3uwGOyUcarKU8Dts6rd6bAR/K
46srMUS787wxy4urZnISSHBycuLuP7med0Ltkw3eEyKgr9/wW4hkK+Xg82pLcH7h
bzMEOtv7AvOvIw7K79R+rwKMIwKBgQDOL1ueYpv/9A9vlnnpKYiB6KIxR/q3VmOi
VW3o85Lile+9ohMkMAlQoyuEfsP9N30xusR0rqu94h+6LY3G9XPmuf5IHV4N49fk
iNFZjJJldLdmhLE5DMxKJKjJoGaDyJPe/+XFxtdl7GlOaLElHMPsURR4y4pPbICR
qqa9MXp5kQKBgQCng+zMbpXCPMdXPu9yJLokuOmNVwnXX4cx+zP+fFsrnWhGr5XS
yP2eRl6U6eqv+SOfdVz2HjGtfh/d2XIJJKMLuV3Ks0fXK4+ESFnmNsZCiLclgveP
4JSPMm0clEWSPbFh4KWfpGUxBxroEamHRU0OlO/2/JDdRNKoHB/iF23rYQKBgQCw
aRKhpEtHJoGifwQVu6SBShKjyas4/CBJP4DHpMeTOKgj/y0TdEo0BTfxqCh2Weiz
CNKX5u8oivWMbPd2OIKO8aof94iGp+ALOAiu7rg/OCrG+1dKsamE8nK7+JJdxNrI
HPhyTJv1J9496RNP5pm3cvPqGnRfWj1y5Ki/DTt2EQKBgQCupzzya0U9EQiLiMBE
jRj+2MILqbXpymJXOuqBUYUP1GalWUfuTrTgJk28j5KIQLwQWgTgRGbNFNBf7iet
YFcp5T/lk1Oidh5EpSdx+uKhWQf7s3Oc5MofmUcdTXrX3GOn52kg99Nn8fJsaW0D
8/XgsOlYdBbtHQV1aDinKiQAnw==
-----END PRIVATE KEY-----`;

// SHA-256 fingerprint of TEST_CERT, in the colon-separated form Proxmox shows.
export const TEST_FINGERPRINT =
  'AD:1B:39:01:4A:63:75:BC:A4:AF:1B:DE:24:96:59:C5:8A:19:30:0F:12:4E:03:87:FD:12:0A:7E:81:90:84:C0';
