import {
  TimelineRepository,
  TimelineFilterOptions,
  TimelineEventDetailRecord,
} from '../persistence/repositories.js';
import { DocumentService } from '../documents/document-service.js';

export interface TimelineListResponse {
  data: TimelineEventDetailRecord[];
  pagination: {
    totalCount: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
}

export interface TimelineDocumentUrlResponse {
  signedUrl: string;
  expiresInSeconds: number;
  filename: string;
  mimeType: string;
}

export class TimelineService {
  constructor(
    private readonly timelineRepo: TimelineRepository,
    private readonly documentService: DocumentService
  ) {}

  /**
   * Retrieves paginated, sorted, and filtered medical timeline events for an authenticated patient.
   */
  async listTimelineEvents(
    patientProfileId: string,
    options: TimelineFilterOptions
  ): Promise<TimelineListResponse> {
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 50);
    const offset = Math.max(options.offset ?? 0, 0);

    const { events, totalCount } = await this.timelineRepo.listTimelineEvents(
      patientProfileId,
      {
        ...options,
        limit,
        offset,
      }
    );

    return {
      data: events,
      pagination: {
        totalCount,
        limit,
        offset,
        hasMore: offset + events.length < totalCount,
      },
    };
  }

  /**
   * Retrieves authorized details for a single timeline event including associated prescription items and document metadata.
   */
  async getTimelineEventDetails(
    id: string,
    patientProfileId: string
  ): Promise<TimelineEventDetailRecord> {
    const event = await this.timelineRepo.getTimelineEventById(id, patientProfileId);
    if (!event) {
      const err = new Error('Medical timeline event not found');
      (err as any).statusCode = 404;
      throw err;
    }

    return event;
  }

  /**
   * Retrieves a short-lived secure download URL for the original source document attached to a timeline event.
   */
  async getDocumentSignedUrl(
    id: string,
    patientProfileId: string
  ): Promise<TimelineDocumentUrlResponse> {
    const event = await this.getTimelineEventDetails(id, patientProfileId);

    if (!event.sourceDocumentId) {
      const err = new Error('No source document associated with this medical event');
      (err as any).statusCode = 404;
      throw err;
    }

    try {
      const signedUrl = await this.documentService.getSignedPreviewUrl(
        patientProfileId,
        event.sourceDocumentId
      );

      return {
        signedUrl,
        expiresInSeconds: 900,
        filename: event.sourceDocument?.originalFilename || 'document',
        mimeType: event.sourceDocument?.mimeType || 'application/octet-stream',
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Source document unavailable';
      const error = new Error(`Source document unavailable: ${message}`);
      (error as any).statusCode = 404;
      throw error;
    }
  }
}
