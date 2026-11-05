import type { Request, Response } from 'express';

export interface AppStatusConfig {
  minVersion: string;
  latestVersion: string;
  maintenance: boolean;
  maintenanceMessage?: string;
}

export function appStatusFromEnv(e: {
  APP_MIN_VERSION: string;
  APP_LATEST_VERSION: string;
  APP_MAINTENANCE: boolean;
  APP_MAINTENANCE_MESSAGE?: string;
}): AppStatusConfig {
  return {
    minVersion: e.APP_MIN_VERSION,
    latestVersion: e.APP_LATEST_VERSION,
    maintenance: e.APP_MAINTENANCE,
    maintenanceMessage: e.APP_MAINTENANCE_MESSAGE,
  };
}

/** Public handler. Returns release and maintenance metadata only; never user data. */
export function createAppStatusHandler(config: AppStatusConfig) {
  return (_req: Request, res: Response): void => {
    const message = config.maintenanceMessage?.trim();
    res.set('Cache-Control', 'no-store');
    res.status(200).json({
      data: {
        minVersion: config.minVersion,
        latestVersion: config.latestVersion,
        maintenance: {
          active: config.maintenance,
          ...(config.maintenance && message ? { message } : {}),
        },
      },
    });
  };
}
