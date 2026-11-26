import { useState } from "react";
import { Link } from "react-router-dom";
import { api, useResource } from "../api";
import type { Key } from "../api";
import { Notice, Status } from "../components";

type CheckResult = { id?: string; status: string };

export function SetupCheck({
  base,
  operation,
  model,
}: {
  base: string;
  operation: string;
  model: string;
}) {
  const keys = useResource<{ data: Key[] }>(base + "/keys");
  const activeKeys = keys.value?.data.filter((item) => !item.revoked_at) ?? [];
  const [key, setKey] = useState("");
  const [check, setCheck] = useState<{ id: string; model: string }>();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<{ model: string; message: string }>();
  const checkID = check?.model === model ? check.id : undefined;
  const path = base + "/setup/checks";
  const result = useResource<CheckResult>(
    checkID ? path + "/" + checkID : null,
    { interval: 2500, stop: checkFinished, stopOnError: true },
  );

  async function start() {
    setPending(true);
    setCheck(undefined);
    setFailure(undefined);
    try {
      const response = await api<{ id: string }>(path, {
        key_id: key,
        model,
        operation,
      });
      setCheck({ id: response.id, model });
    } catch (e) {
      setFailure({ model, message: (e as Error).message });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="setup-check">
      <label>
        验证使用的密钥
        <select
          value={key}
          disabled={pending}
          onChange={(event) => {
            setKey(event.target.value);
            setCheck(undefined);
            setFailure(undefined);
          }}
        >
          <option value="">选择密钥</option>
          {activeKeys.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
      <button
        disabled={
          pending || !model || !activeKeys.some((item) => item.id === key)
        }
        onClick={start}
      >
        {pending ? "正在启动验证…" : "开始验证"}
      </button>
      <Notice
        error={
          keys.error ||
          result.error ||
          (failure?.model === model ? failure.message : undefined)
        }
      />
      {checkID && !result.error && (
        <p>
          使用该配置发送生成请求。{" "}
          <Status value={result.value?.status ?? "waiting"} />
          {result.value?.id && (
            <Link to={"requests/" + result.value.id}> 查看请求</Link>
          )}
        </p>
      )}
    </div>
  );
}

function checkFinished(result: CheckResult) {
  return result.status === "succeeded";
}
