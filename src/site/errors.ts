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

/**
 * "Eigenes Board verwenden" is missing, but the user menu does not say "logged out": the page changed or is slow
 * (`loggedIn` true), or the login could not be told (`loggedIn` null). Not a lost login.
 */
export class OwnBoardsUnavailableError extends Error {
  constructor(
    message: string,
    readonly loggedIn: boolean | null,
  ) {
    super(message);
    this.name = 'OwnBoardsUnavailableError';
  }
}
