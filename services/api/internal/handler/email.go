package handler

import (
	"fmt"
	"net/smtp"

	"github.com/lima/api/internal/config"
	"go.uber.org/zap"
)

// sendMagicLinkEmail sends a magic-link login email to the given address.
// If SMTP is not configured it logs the link instead (useful for local dev).
func sendMagicLinkEmail(cfg *config.Config, log *zap.Logger, toAddr, magicURL string) error {
	if cfg.SMTPHost == "" {
		log.Info("SMTP not configured — magic link (dev mode)", zap.String("to", toAddr), zap.String("url", magicURL))
		return nil
	}

	addr := fmt.Sprintf("%s:%s", cfg.SMTPHost, cfg.SMTPPort)
	auth := smtp.PlainAuth("", cfg.SMTPUser, cfg.SMTPPass, cfg.SMTPHost)

	subject := "Your Lima login link"
	body := fmt.Sprintf("Click the link below to log in to Lima. It expires in 15 minutes.\n\n%s\n\nIf you did not request this, ignore this email.", magicURL)
	msg := []byte(fmt.Sprintf(
		"From: %s\r\nTo: %s\r\nSubject: %s\r\n\r\n%s",
		cfg.EmailFrom, toAddr, subject, body,
	))

	return smtp.SendMail(addr, auth, cfg.EmailFrom, []string{toAddr}, msg)
}
