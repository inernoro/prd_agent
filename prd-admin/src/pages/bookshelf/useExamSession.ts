/**
 * 结业考的状态机 —— 桌面弹窗与手机全屏两套外观共用这一份。
 *
 * 为什么抽出来：手机端按 390 终稿把考试从「弹窗」改成「整屏」之后，答题、给分、
 * 判通关、挑推荐书这几件事会在两个组件里各写一遍，而它们必须给出同一个答案。
 * 判据抄成两份就会各自漂移（predicate-and-wiring-discipline 形状 3），
 * 而漂移的表现是「同一份卷子在手机上和电脑上算出不同的通关结论」——
 * 编译过、测试绿、两边单独看都对。
 *
 * 所以这里是唯一判定源：外观只负责画，分数与结论一律问它。
 */
import { useMemo, useState } from 'react';
import { questionsOf, isPassed } from '@/lib/bookshelf/exams';
import { stanceOf, type ExamStance } from '@/lib/bookshelf/examContext';
import { useBookshelfStore } from '@/stores/bookshelfStore';
import type { Volume, BookEntry, ExamQuestion } from '@/lib/bookshelf/types';

export interface ExamSession {
  questions: ExamQuestion[];
  /** 题号 → 选中的选项下标 */
  picked: Record<string, number>;
  pick: (questionId: string, optionIndex: number) => void;
  submitted: boolean;
  submit: () => void;
  reset: () => void;

  answeredCount: number;
  correctCount: number;
  passed: boolean;

  /** 交卷时这一卷读了几本 —— 决定这个分数该怎么读。按整卷算，不受开发/产品筛选影响。 */
  readBooks: number;
  totalBooks: number;
  stance: ExamStance;

  /** 没读就考、又错了几题的人，最需要的不是「未通过」，是「先读哪两本」。 */
  suggestedBooks: BookEntry[];
}

export function useExamSession(volume: Volume | null): ExamSession {
  const questions = useMemo(() => (volume ? questionsOf(volume.id) : []), [volume]);
  const [picked, setPicked] = useState<Record<string, number>>({});
  const [submitted, setSubmitted] = useState(false);
  const recordExam = useBookshelfStore((s) => s.recordExam);
  const readBookIds = useBookshelfStore((s) => s.readBookIds);

  const totalBooks = volume?.books.length ?? 0;
  const readBooks = volume ? volume.books.filter((b) => readBookIds.includes(b.id)).length : 0;
  const stance = stanceOf(readBooks, totalBooks);

  const answeredCount = Object.keys(picked).length;
  const correctCount = questions.filter((q) => picked[q.id] === q.answer).length;
  const passed = isPassed(correctCount, questions.length);

  const suggestedBooks = useMemo(() => {
    if (!volume) return [];
    return volume.books
      .filter((b) => !readBookIds.includes(b.id))
      .slice()
      .sort((a, b) => a.level - b.level)
      .slice(0, 2);
  }, [volume, readBookIds]);

  return {
    questions,
    picked,
    pick: (questionId, optionIndex) => setPicked((p) => ({ ...p, [questionId]: optionIndex })),
    submitted,
    submit: () => {
      if (!volume) return;
      setSubmitted(true);
      recordExam({
        volumeId: volume.id,
        correct: correctCount,
        total: questions.length,
        passed: isPassed(correctCount, questions.length),
        readAtExam: readBooks,
        totalAtExam: totalBooks,
        takenAt: new Date().toISOString(),
      });
    },
    reset: () => {
      setPicked({});
      setSubmitted(false);
    },
    answeredCount,
    correctCount,
    passed,
    readBooks,
    totalBooks,
    stance,
    suggestedBooks,
  };
}
