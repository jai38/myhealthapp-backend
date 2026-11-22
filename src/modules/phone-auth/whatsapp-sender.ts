/**
 * Sends one-time codes on WhatsApp. The Meta Cloud API is the chosen route (Phase 5 task 6).
 * Nothing here logs; errors carry no phone number or code.
 */
export interface WhatsAppSendResult {
  /** The provider's message id, matched later against delivery webhooks. */
  providerMessageId?: string;
}

export interface WhatsAppSender {
  readonly enabled: boolean;
  sendCode(phoneE164: string, code: string): Promise<WhatsAppSendResult>;
}

export class WhatsAppSendError extends Error {
  constructor(public readonly kind: 'UNAVAILABLE' | 'FAILED') {
    super(kind === 'UNAVAILABLE' ? 'Recipient is not reachable on WhatsApp' : 'WhatsApp send failed');
    this.name = 'WhatsAppSendError';
  }
}

/** Production before Meta approval: the code routes answer 503 OTP_UNAVAILABLE. */
export class DisabledWhatsAppSender implements WhatsAppSender {
  readonly enabled = false;
  async sendCode(): Promise<WhatsAppSendResult> {
    throw new WhatsAppSendError('FAILED');
  }
}

/** Local and tests only; validateProductionConfig refuses it in production. */
export class MemoryWhatsAppSender implements WhatsAppSender {
  readonly enabled = true;
  readonly sent: Array<{ phoneE164: string; code: string; providerMessageId: string }> = [];
  failNextSend = false;

  async sendCode(phoneE164: string, code: string): Promise<WhatsAppSendResult> {
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new WhatsAppSendError('FAILED');
    }
    const providerMessageId = `wamid.memory.${this.sent.length + 1}`;
    this.sent.push({ phoneE164, code, providerMessageId });
    return { providerMessageId };
  }

  lastCodeFor(phoneE164: string): string | undefined {
    return [...this.sent].reverse().find((m) => m.phoneE164 === phoneE164)?.code;
  }
}

export interface MetaSenderConfig {
  token: string;
  phoneNumberId: string;
  templateName: string;
  templateLanguage: string;
  graphApiVersion: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Meta Cloud API, authentication template with a copy-code button. The template body is fixed by
 * Meta ("{code} is your verification code."); the code goes in the body and in the button.
 */
export class MetaCloudWhatsAppSender implements WhatsAppSender {
  readonly enabled = true;
  constructor(private readonly config: MetaSenderConfig) {}

  async sendCode(phoneE164: string, code: string): Promise<WhatsAppSendResult> {
    const fetchImpl = this.config.fetchImpl ?? fetch;
    const url = `https://graph.facebook.com/${this.config.graphApiVersion}/${encodeURIComponent(this.config.phoneNumberId)}/messages`;
    const body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: phoneE164.replace(/^\+/, ''),
      type: 'template',
      template: {
        name: this.config.templateName,
        language: { code: this.config.templateLanguage },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: code }] },
          { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] },
        ],
      },
    };

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.config.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 10_000),
      });
    } catch {
      throw new WhatsAppSendError('FAILED');
    }

    let payload: any = undefined;
    try {
      payload = await response.json();
    } catch {
      // Treated as a failure below.
    }

    if (!response.ok) {
      // 131026: undeliverable, which includes "not on WhatsApp". Usually reported later by webhook.
      const code = payload?.error?.code;
      throw new WhatsAppSendError(code === 131026 ? 'UNAVAILABLE' : 'FAILED');
    }
    const id = payload?.messages?.[0]?.id;
    return { providerMessageId: typeof id === 'string' ? id : undefined };
  }
}
