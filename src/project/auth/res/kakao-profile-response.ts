export interface KakaoProfileResponse {
  id: number;
  connected_at?: string;

  kakao_account?: {
    email?: string;
    is_email_valid?: boolean;
    is_email_verified?: boolean;

    profile?: {
      nickname?: string;
      profile_image_url?: string;
      thumbnail_image_url?: string;
    };
  };
}
