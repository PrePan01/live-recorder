import { Form, Select } from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  createKeywordPlan,
  deleteKeywordPlan,
  fetchKeywordPlans,
  updateKeywordPlan,
  type KeywordPlan,
} from "../../../api/keywordPlan";
import PlanPanel from "./PlanPanel";

type Values = Partial<
  Pick<KeywordPlan, "includeKeywords" | "excludeKeywords" | "enabled">
>;

const columns: ColumnsType<KeywordPlan> = [
  {
    title: "包含任意",
    dataIndex: "includeKeywords",
    ellipsis: true,
    render: (words: string[]) => words.join("、") || "无",
  },
  {
    title: "不包含任何",
    dataIndex: "excludeKeywords",
    ellipsis: true,
    render: (words: string[]) => words.join("、") || "无",
  },
];

function initialValues(plan: KeywordPlan | null): Values {
  return {
    includeKeywords: plan?.includeKeywords ?? [],
    excludeKeywords: plan?.excludeKeywords ?? [],
    enabled: plan?.enabled ?? true,
  };
}

function save(roomId: string, plan: KeywordPlan | null, values: Values) {
  const input = {
    includeKeywords: values.includeKeywords ?? [],
    excludeKeywords: values.excludeKeywords ?? [],
    enabled: values.enabled ?? true,
  };
  return plan
    ? updateKeywordPlan(roomId, plan.id, input)
    : createKeywordPlan(roomId, input);
}

function normalizeKeywords(words: string[]): string[] {
  const seen = new Set<string>();
  return words
    .map((word) => word.trim())
    .filter((word) => {
      const key = word.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

const keywordInput = {
  mode: "tags" as const,
  open: false,
  suffixIcon: null,
  tokenSeparators: ["\r\n", "\n"],
  placeholder: "输入关键词，按回车添加",
};

export default function KeywordPlanPanel({
  roomId,
  onCountChange,
}: {
  roomId: string;
  onCountChange: (count: number) => void;
}) {
  return (
    <PlanPanel
      roomId={roomId}
      label="关键词计划"
      inlineEditor
      columns={columns}
      scrollWidth={480}
      load={fetchKeywordPlans}
      onCountChange={onCountChange}
      remove={deleteKeywordPlan}
      save={save}
      initialValues={initialValues}
      toggle={(id, plan, enabled) =>
        updateKeywordPlan(id, plan.id, { enabled })
      }
      fields={
        <div className="lr-keyword-plan-fields">
          <Form.Item
            label="包含的关键词"
            name="includeKeywords"
            className="lr-keyword-plan-include"
            normalize={normalizeKeywords}
            extra={"直播间标题包含这些关键词，就启动开启录制"}
          >
            <Select<string[]> {...keywordInput} autoFocus />
          </Form.Item>
          <Form.Item
            label="排除的关键词"
            name="excludeKeywords"
            className="lr-keyword-plan-exclude"
            normalize={normalizeKeywords}
            dependencies={["includeKeywords"]}
            extra={"直播间标题不包含这些关键词，就启动开启录制"}
            rules={[
              (form) => ({
                validator: (_, value: string[] | undefined) =>
                  value?.length ||
                  (
                    form.getFieldValue("includeKeywords") as
                      string[] | undefined
                  )?.length
                    ? Promise.resolve()
                    : Promise.reject(
                        new Error("请至少填写一个包含或不包含的关键词"),
                      ),
              }),
            ]}
          >
            <Select<string[]> {...keywordInput} />
          </Form.Item>
        </div>
      }
    />
  );
}
