/**
 * MessagingProvider — mock-first (Playbook 0.5). Real SMS gateways are
 * config-selected adapters; DC-15 SMS notification fallback rides on this too.
 */
export interface SmsMessage {
  phone: string;
  body: string;
  senderId: string;
}

export interface MessagingProvider {
  sendSms(msg: SmsMessage): Promise<void>;
}

export class MockMessagingProvider implements MessagingProvider {
  readonly sent: SmsMessage[] = [];

  async sendSms(msg: SmsMessage): Promise<void> {
    this.sent.push(msg);
  }

  lastTo(phone: string): SmsMessage | undefined {
    return [...this.sent].reverse().find((m) => m.phone === phone);
  }
}
