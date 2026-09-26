# puppyready

A small, standard-library-only Go implementation of the PlayReady pieces needed
for license challenge generation and XMR content-key extraction.

It is a focused Go port of the `Device`, `PSSH`, and `Cdm` functionality from
[pyplayready](https://git.gay/ready-dl/pyplayready). Features outside that
license-acquisition path are intentionally not included.

## Public API

```go
device, err := puppyready.LoadDevice("device.prd")
cdm := puppyready.NewCDM(device)
sessionID, err := cdm.Open()
defer cdm.Close(sessionID)

pssh, err := puppyready.ParsePSSH(psshBase64)
challenge, err := cdm.GetLicenseChallenge(sessionID, pssh.WRMHeaders[0])
// Send challenge to a PlayReady license server.

err = cdm.ParseLicense(sessionID, licenseXML)
keys, err := cdm.GetKeys(sessionID)
for _, key := range keys {
    fmt.Printf("%s:%x\n", key.ID, key.Key)
}
```

Only the Go standard library is required.

## Attribution

The PlayReady interoperability logic is based on pyplayready and retains the
same conceptual API where practical. Review the upstream project and its
license terms before redistribution.