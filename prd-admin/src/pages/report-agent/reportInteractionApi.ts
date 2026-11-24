import {
  createComment,
  createMonthlyComment,
  deleteComment,
  deleteMonthlyComment,
  likeMonthlyReport,
  likeReport,
  listComments,
  listMonthlyComments,
  listMonthlyLikes,
  listReportLikes,
  unlikeMonthlyReport,
  unlikeReport,
  updateComment,
  updateMonthlyComment,
  uploadMonthlyCommentImage,
  uploadReportCommentImage,
} from '@/services';
import type {
  CreateCommentContract,
  DeleteCommentContract,
  LikeReportContract,
  ListCommentsContract,
  ListReportLikesContract,
  UnlikeReportContract,
  UpdateCommentContract,
  UploadReportCommentImageContract,
} from '@/services/contracts/reportAgent';

/** 报告种类：周报与月报共用同一套评论 / 点赞组件，只是打到不同的接口 */
export type ReportKind = 'weekly' | 'monthly';

export interface ReportInteractionApi {
  listComments: ListCommentsContract;
  createComment: CreateCommentContract;
  updateComment: UpdateCommentContract;
  deleteComment: DeleteCommentContract;
  uploadCommentImage: UploadReportCommentImageContract;
  listLikes: ListReportLikesContract;
  like: LikeReportContract;
  unlike: UnlikeReportContract;
}

export const REPORT_INTERACTION_API_REGISTRY: Record<ReportKind, ReportInteractionApi> = {
  weekly: {
    listComments,
    createComment,
    updateComment,
    deleteComment,
    uploadCommentImage: uploadReportCommentImage,
    listLikes: listReportLikes,
    like: likeReport,
    unlike: unlikeReport,
  },
  monthly: {
    listComments: listMonthlyComments,
    createComment: createMonthlyComment,
    updateComment: updateMonthlyComment,
    deleteComment: deleteMonthlyComment,
    uploadCommentImage: uploadMonthlyCommentImage,
    listLikes: listMonthlyLikes,
    like: likeMonthlyReport,
    unlike: unlikeMonthlyReport,
  },
};

export function getReportInteractionApi(kind: ReportKind = 'weekly'): ReportInteractionApi {
  return REPORT_INTERACTION_API_REGISTRY[kind];
}
