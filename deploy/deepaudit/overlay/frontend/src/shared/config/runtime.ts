/** CDS images expose only the static review workflow. Upstream builds default to full UI. */
export const isCdsStaticReview = import.meta.env.VITE_CDS_STATIC_REVIEW === "true";
