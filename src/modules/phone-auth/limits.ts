/**
 * Every phone sign-in limit in one place (brief hard rules 6-7, screens S01/S02, P2, P3).
 * Rate-limit keys are keyed hashes of the number, install id and IP; never the values themselves.
 */
export const PHONE_AUTH_LIMITS = {
  codeLength: 6,
  codeTtlSeconds: 10 * 60,
  /** No new code for the same number sooner than this after the last one. */
  resendAfterSeconds: 30,
  /** The fourth wrong code locks that code. */
  maxWrongAttemptsPerCode: 3,
  /** The first code plus 3 resends; the next request waits for the window to clear. */
  maxCodesPerNumber: 4,
  numberWindowSeconds: 10 * 60,
  maxCodesPerInstallPerHour: 10,
  maxCodesPerIpPerHour: 20,
  /** Request rows (with the number) are deleted this long after they were made. */
  requestRetentionSeconds: 24 * 60 * 60,

  accessTokenTtlSeconds: 15 * 60,
  refreshTokenTtlSeconds: 30 * 24 * 60 * 60,

  secondFactorTtlSeconds: 10 * 60,
  maxSecondFactorAttempts: 5,
  /** P2: a new device, no passkey or recovery code, and no use for this long: records are hidden. */
  inactiveDaysBeforeSupportHold: 90,
  /** P4: under this age, S03 is refused and nothing is stored. */
  minimumAgeYears: 18,
} as const;
