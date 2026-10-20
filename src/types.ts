export type AgentId = 'orchestrator' | 'coder' | 'reviewer';

export type AgentProfile = {
  id: AgentId;
  name: string;
  role: string;
  tagline: string;
  system?: string;
  accent: string;
};

export type VoiceProfile = {
  elevenVoiceId: string;
  elevenLabel: string;
  pitch: number;
  rate: number;
};

export type Bootstrap = {
  app: string;
  tagline: string;
  auth: {
    method: string;
    otpDigits: number;
    otpMinutes: number;
    pinDigits: number;
    senderName: string;
    senderAddress: string;
    mailConfigured: boolean;
  };
  providers: ProviderPreset[];
  agents: AgentProfile[];
  themes: Array<{ id: string; label: string }>;
};

export type ProviderPreset = {
  id: string;
  label: string;
  kind: 'llm' | 'tts';
  baseUrl: string;
  defaultModel?: string;
  docs: string;
  keyHint: string;
  local?: boolean;
  note?: string;
};

export type Me = {
  sub: string;
  provider: 'email';
  tag: string;
  displayName: string | null;
  email: string | null;
  picture: string | null;
  theme: string;
  pinEnabled: boolean;
  voiceProfile: Partial<Record<AgentId, VoiceProfile>> | null;
  createdAt: string;
};

export const THEMES_25: Array<{ id: string; label: string }> = [
  { id: 'classic-dark', label: 'Classic Dark' },
  { id: 'stranger-things', label: 'Stranger Things' },
  { id: 'from-series', label: 'From Series' },
  { id: 'arc-reactor', label: 'Arc Reactor' },
  { id: 'cyberpunk', label: 'Cyberpunk' },
  { id: 'dracula', label: 'Dracula' },
  { id: 'monokai', label: 'Monokai' },
  { id: 'nord', label: 'Nord' },
  { id: 'gruvbox', label: 'Gruvbox' },
  { id: 'tokyo-night', label: 'Tokyo Night' },
  { id: 'one-dark-pro', label: 'One Dark Pro' },
  { id: 'catppuccin-mocha', label: 'Catppuccin Mocha' },
  { id: 'synthwave-84', label: 'Synthwave 84' },
  { id: 'matrix-green', label: 'Matrix Green' },
  { id: 'solarized-dark', label: 'Solarized Dark' },
  { id: 'github-dark', label: 'GitHub Dark' },
  { id: 'midnight-blue', label: 'Midnight Blue' },
  { id: 'emerald-abyss', label: 'Emerald Abyss' },
  { id: 'sunset-vibes', label: 'Sunset Vibes' },
  { id: 'rose-pine', label: 'Rose Pine' },
  { id: 'palenight', label: 'Palenight' },
  { id: 'mind-flayer-void', label: 'Mind Flayer Void' },
  { id: 'vecna-curse', label: 'Vecna Curse' },
  { id: 'obsidian-gold', label: 'Obsidian Gold' },
  { id: 'titanium-glass', label: 'Titanium Glass' },
];

export type Connector = {
  id: string;
  provider: string;
  providerLabel: string;
  name: string;
  baseUrl: string | null;
  model: string | null;
  isDefault: boolean;
  enabled: boolean;
  kind: 'llm' | 'tts';
  hasKey: boolean;
  keyHint: string;
  createdAt: string;
};

export type ChatSummary = {
  id: string;
  title: string;
  mode: string;
  locked: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ChatMessage = {
  id?: string;
  role: string;
  agent?: string | null;
  content: string;
  meta?: string | null;
  created_at?: string;
};

export type CallEntry = { speaker: string; text: string };

export type MailItem = {
  id: string;
  to_email: string;
  from_email: string;
  subject: string;
  html: string;
  body_text: string;
  status: string;
  provider: string | null;
  error: string | null;
  created_at: string;
  sent_at: string | null;
};
