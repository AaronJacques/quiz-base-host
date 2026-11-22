/** The browser profile is not logged in to quiz-base (own boards, board editor). */
export class NotLoggedInError extends Error {
  constructor(message = 'Nicht bei quiz-base angemeldet.') {
    super(message);
    this.name = 'NotLoggedInError';
  }
}

/** Appends the command to log in again (`account.loginCommand`) to a NotLoggedInError – for chat and terminal. */
export function withLoginHint(e: NotLoggedInError, loginCommand: string): NotLoggedInError {
  return new NotLoggedInError(`${e.message} Neu anmelden: \`${loginCommand}\``);
}
