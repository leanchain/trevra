/**
 * The one error type the Reddit routes throw, carrying the status they mean.
 *
 * Same shape and same reason as `LinkedInApiError`: most refusals in this
 * subsystem are FACTS AN OPERATOR CAN ACT ON -- automation is off, this
 * deployment is hosted, Reddit wants a captcha -- and none of those is a
 * server fault. Throwing a typed error lets one wrapper turn them into the
 * status they deserve while anything genuinely unexpected still reaches the
 * shared 500 handler untouched.
 *
 * NOTHING CONSTRUCTED FROM A CREDENTIAL MAY BE PASSED IN HERE. Every message
 * the routes build comes from a constant or from `driver.ts`, which builds its
 * own from constants and page URLs.
 */
export class RedditApiError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = 'RedditApiError';
  }
}
