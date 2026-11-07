// Package access decides who may reach the terminals: one-time pairing codes
// minted on the host, device cookies, and the HTTP guard around every route.
//
// State lives in files so the `remotty pair` and `remotty revoke` commands work
// whether or not the server is running. Only hashes of secrets are stored.
package access

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

const (
	codeTTL     = 5 * time.Minute
	maxAttempts = 5
	// A device expires after this long WITHOUT use. Every use pushes the expiry
	// forward, so a tablet in regular use stays paired indefinitely.
	deviceTTL = 30 * 24 * time.Hour
	// Renewal rewrites devices.json at most once per this interval, not on
	// every request (30 tabs poll every 2 s).
	renewEvery = 24 * time.Hour
)

// ErrInvalidCode covers wrong, expired, used and exhausted codes alike, so a
// guesser learns nothing about which one it hit.
var ErrInvalidCode = errors.New("invalid or expired pairing code")

// Device is one paired browser.
type Device struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	TokenHash string    `json:"token_hash"`
	Created   time.Time `json:"created"`
	Expires   time.Time `json:"expires"`
}

type pendingCode struct {
	Hash     string    `json:"hash"`
	Expires  time.Time `json:"expires"`
	Attempts int       `json:"attempts"`
}

// Store keeps pairing state in Dir. Now is injectable so tests can expire things.
type Store struct {
	Dir string
	Now func() time.Time
}

func (s Store) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

func (s Store) path(name string) string { return filepath.Join(s.Dir, name) }

// locked serializes writers across processes: the server redeems codes while
// the CLI mints or revokes.
func (s Store) locked(fn func() error) error {
	if err := os.MkdirAll(s.Dir, 0o700); err != nil {
		return err
	}
	f, err := os.OpenFile(s.path(".lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != nil {
		return err
	}
	defer syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
	return fn()
}

// NewCode replaces any pending code with a fresh one: 10 base32 chars, 50 bits.
func (s Store) NewCode() (string, error) {
	code := rand.Text()[:10]
	err := s.locked(func() error {
		return writeJSON(s.path("pending.json"), pendingCode{Hash: hash(code), Expires: s.now().Add(codeTTL)})
	})
	return code, err
}

// Redeem trades a pairing code for a device token. The code works once; five
// wrong guesses burn it.
func (s Store) Redeem(code, name string) (token string, dev Device, err error) {
	err = s.locked(func() error {
		if err := s.consumeCode(code); err != nil {
			return err
		}
		token, dev, err = s.addDevice(name)
		return err
	})
	return token, dev, err
}

// consumeCode checks code against the pending one and deletes it on success.
func (s Store) consumeCode(code string) error {
	var p pendingCode
	if err := readJSON(s.path("pending.json"), &p); err != nil {
		return err
	}
	if p.Hash == "" || s.now().After(p.Expires) {
		return ErrInvalidCode
	}
	if subtle.ConstantTimeCompare([]byte(hash(NormalizeCode(code))), []byte(p.Hash)) != 1 {
		return s.recordFailure(p)
	}
	return os.Remove(s.path("pending.json"))
}

func (s Store) addDevice(name string) (string, Device, error) {
	token := rand.Text()
	dev := Device{ID: rand.Text()[:6], Name: CleanName(name), TokenHash: hash(token), Created: s.now(), Expires: s.now().Add(deviceTTL)}
	devices, err := s.readDevices()
	if err != nil {
		return "", Device{}, err
	}
	return token, dev, writeJSON(s.path("devices.json"), append(devices, dev))
}

func (s Store) recordFailure(p pendingCode) error {
	p.Attempts++
	if p.Attempts >= maxAttempts {
		os.Remove(s.path("pending.json"))
		return ErrInvalidCode
	}
	if err := writeJSON(s.path("pending.json"), p); err != nil {
		return err
	}
	return ErrInvalidCode
}

// Lookup returns the live device a token belongs to.
func (s Store) Lookup(token string) (Device, bool) {
	if token == "" {
		return Device{}, false
	}
	devices, err := s.readDevices()
	if err != nil {
		return Device{}, false
	}
	want := hash(token)
	for _, d := range devices {
		if d.TokenHash == want && s.now().Before(d.Expires) {
			return s.renew(d), true
		}
	}
	return Device{}, false
}

// renew slides a device's expiry forward from now. It writes only once a day
// and treats a failed write as harmless: the device stays valid until its
// current expiry either way.
func (s Store) renew(d Device) Device {
	target := s.now().Add(deviceTTL)
	if target.Sub(d.Expires) < renewEvery {
		return d
	}
	s.locked(func() error {
		devices, err := s.readDevices()
		if err != nil {
			return err
		}
		for i := range devices {
			if devices[i].ID == d.ID { // re-read under the lock: it may have been revoked meanwhile
				devices[i].Expires = target
				d.Expires = target
				return writeJSON(s.path("devices.json"), devices)
			}
		}
		return nil
	})
	return d
}

// Active reports whether a device is still paired and unexpired.
func (s Store) Active(id string) bool {
	devices, err := s.readDevices()
	if err != nil {
		return false // fail closed: an unreadable store must not keep sockets open
	}
	for _, d := range devices {
		if d.ID == id && s.now().Before(d.Expires) {
			return true
		}
	}
	return false
}

// Devices lists paired devices.
func (s Store) Devices() ([]Device, error) { return s.readDevices() }

// Revoke unpairs one device, or every device when id is "". It returns how many went.
func (s Store) Revoke(id string) (int, error) {
	removed := 0
	err := s.locked(func() error {
		devices, err := s.readDevices()
		if err != nil {
			return err
		}
		kept := []Device{}
		for _, d := range devices {
			if id == "" || d.ID == id {
				removed++
				continue
			}
			kept = append(kept, d)
		}
		return writeJSON(s.path("devices.json"), kept)
	})
	return removed, err
}

func (s Store) readDevices() ([]Device, error) {
	devices := []Device{}
	err := readJSON(s.path("devices.json"), &devices)
	return devices, err
}

// NormalizeCode lets people type the code in any case, with or without the dash.
func NormalizeCode(code string) string {
	return strings.ToUpper(strings.NewReplacer("-", "", " ", "").Replace(code))
}

// CleanName keeps device names printable and short; they end up in the CLI.
func CleanName(name string) string {
	name = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, strings.TrimSpace(name))
	if r := []rune(name); len(r) > 40 {
		name = string(r[:40])
	}
	if name == "" {
		return "device"
	}
	return name
}

func hash(secret string) string {
	sum := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(sum[:])
}

func readJSON(path string, v any) error {
	b, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	return json.Unmarshal(b, v)
}

// writeJSON replaces the file atomically so a crash never leaves half a store.
func writeJSON(path string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
