/** 建置識別碼。CI 會填入 commit SHA 前 7 碼，本機開發顯示 dev。 */
export const BUILD_ID: string =
  ((import.meta.env.VITE_BUILD_ID as string | undefined) ?? 'dev').slice(0, 7);
