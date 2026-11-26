import { useState } from "react";
import type { FormEvent } from "react";
import { Field } from "../components";
import { providerDetails, providerOptions } from "../providers";
import type { ProviderID } from "../providers";

export function ConnectionForm({
  defaultProvider,
  saving,
  onSubmit,
}: {
  defaultProvider: ProviderID;
  saving: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const [provider, setProvider] = useState<ProviderID>();
  const id = provider ?? defaultProvider;
  const details = providerDetails(id);
  return (
    <form onSubmit={onSubmit}>
      <label>
        供应商
        <select
          name="provider"
          value={id}
          disabled={saving}
          onChange={(event) => {
            const value = event.target.value;
            setProvider(providerOptions.find((option) => option === value));
          }}
        >
          {providerOptions.map((option) => (
            <option key={option} value={option}>
              {providerDetails(option).label}
            </option>
          ))}
        </select>
      </label>
      {details.instructions && (
        <p className="studio-empty">{details.instructions}</p>
      )}
      {details.basePlaceholder && (
        <>
          <Field label="名称" name="label" />
          <label>
            上游地址
            <input
              key={id}
              name="base"
              type="url"
              placeholder={details.basePlaceholder}
              required
            />
          </label>
          <Field label="共享额度域" name="quota" />
          <Field label="上游数据区域" name="region" required={false} />
        </>
      )}
      <label>
        {details.credentialLabel ?? "上游凭证"}
        <input
          key={id}
          name="token"
          type="password"
          placeholder={details.credentialPlaceholder}
          autoComplete="new-password"
          required
        />
      </label>
      <button disabled={saving}>保存连接</button>
    </form>
  );
}
