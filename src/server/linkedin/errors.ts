/** A 4xx an operator caused. Routes map `status` straight onto the response. */
export class LinkedInApiError extends Error {
  constructor(
    message: string,
    public readonly status = 400
  ) {
    super(message);
    this.name = 'LinkedInApiError';
  }
}
