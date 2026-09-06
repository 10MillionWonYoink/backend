export interface SignupTokenPayload {
  sub: number;
  purpose: 'signup';
  iat?: number;
  exp?: number;
}

export interface AccessTokenPayload {
  sub: number;
  type: 'access';
  iat?: number;
  exp?: number;
}

export interface RefreshTokenPayload {
  sub: number;
  type: 'refresh';
  iat?: number;
  exp?: number;
}
