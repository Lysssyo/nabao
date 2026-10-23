export type RunStatus = "success" | "partial" | "blocked" | "no-change";
export interface SourceAuthor {
  id: string;
  name: string;
  profileUrl: string;
  seedNotes?: DiscoveredNote[];
}
export interface DiscoveredNote {
  noteId: string;
  url: string;
  canonicalUrl: string;
  title?: string;
  pinned?: boolean;
}
export interface ProfileNoteCard {
  links: string[];
  title: string;
  pinned: boolean;
}
export interface RawNotePage {
  title: string;
  body: string;
  authorIds: string[];
  imageCandidates: { url: string; ordinal: number | null }[];
  expectedImageCount: number | null;
  sourcePublishedAt: string | null;
  sourceUpdatedAt: string | null;
  accessRestricted: boolean;
  restrictionReason: string | null;
}
export interface ImageEvidence {
  ordinal: number;
  sourceUrl: string;
  file: string;
  sha256: string;
  mediaType: string;
  size: number;
}
export interface NoteCapture {
  noteId: string;
  authorId: string;
  evidenceRef: string;
  openUrl?: string;
  capturedAt: string;
  title: string;
  body: string;
  expectedImageCount: number | null;
  images: ImageEvidence[];
  sourcePublishedAt: string | null;
  sourceUpdatedAt: string | null;
  revision: string | null;
  captureStatus: RunStatus;
  issues: string[];
}
export interface Observation {
  authorId: string;
  noteId: string;
  noteRevision: string;
  fundCode: string;
  fundName: string;
  channelScope: "DIRECT" | "DISTRIBUTOR" | "PARTIAL" | "UNSPECIFIED";
  businessType: "PURCHASE" | "DCA" | "UNSPECIFIED";
  period: "DAILY" | "PER_ORDER" | "UNSPECIFIED";
  limitKind: "LIMITED" | "PAUSED" | "UNAVAILABLE" | "UNLIMITED" | "UNKNOWN";
  amountMinor: number | null;
  currency: "CNY" | "USD" | "UNSPECIFIED";
  observedForDate: string;
  sourcePublishedAt: string;
  sourceUpdatedAt: string | null;
  capturedAt: string;
  evidenceRef: string;
  sourceGroupId?: string;
}
