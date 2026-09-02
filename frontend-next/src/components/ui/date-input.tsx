import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import {
  formatDateInput,
  formatZonedDateTimeInput,
  parseDateInput,
  parseZonedDateTimeInput,
} from "@/lib/utils";

interface DateTextInputProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  ariaLabel?: string;
}

export function DateTextInput({
  id,
  value,
  onChange,
  required,
  ariaLabel,
}: DateTextInputProps) {
  const formatted = formatDateInput(value);
  const [draft, setDraft] = useState(formatted);
  useEffect(() => setDraft(formatted), [formatted]);
  const parsed = draft ? parseDateInput(draft) : "";
  const invalid = Boolean(draft && !parsed);

  return (
    <Input
      id={id}
      type="text"
      inputMode="numeric"
      autoComplete="off"
      placeholder="DD/MM/YYYY"
      pattern="[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}"
      title="Enter a date as DD/MM/YYYY"
      value={draft}
      required={required}
      aria-label={ariaLabel}
      aria-invalid={invalid || undefined}
      onChange={(event) => {
        const next = event.target.value;
        setDraft(next);
        const nextValue = next ? parseDateInput(next) : "";
        event.target.setCustomValidity(next && !nextValue ? "Enter a valid date as DD/MM/YYYY" : "");
        if (nextValue !== null) onChange(nextValue);
      }}
      onBlur={(event) => {
        event.currentTarget.setCustomValidity("");
        setDraft(formatDateInput(value));
      }}
    />
  );
}

interface ZonedDateTimeTextInputProps extends DateTextInputProps {
  timeZone: string;
}

export function ZonedDateTimeTextInput({
  id,
  value,
  onChange,
  required,
  ariaLabel,
  timeZone,
}: ZonedDateTimeTextInputProps) {
  const formatted = formatZonedDateTimeInput(value, timeZone);
  const [draft, setDraft] = useState(formatted);
  useEffect(() => setDraft(formatted), [formatted]);
  const parsed = draft ? parseZonedDateTimeInput(draft, timeZone) : "";
  const invalid = Boolean(draft && !parsed);

  return (
    <Input
      id={id}
      type="text"
      inputMode="numeric"
      autoComplete="off"
      placeholder="DD/MM/YYYY, HH:mm"
      pattern="[0-9]{1,2}/[0-9]{1,2}/[0-9]{4},? [0-9]{1,2}:[0-9]{2}"
      title="Enter date and time as DD/MM/YYYY, HH:mm using a 24-hour clock"
      value={draft}
      required={required}
      aria-label={ariaLabel}
      aria-invalid={invalid || undefined}
      onChange={(event) => {
        const next = event.target.value;
        setDraft(next);
        const nextValue = next ? parseZonedDateTimeInput(next, timeZone) : "";
        event.target.setCustomValidity(next && !nextValue ? "Enter a valid date and 24-hour time for the selected timezone" : "");
        if (nextValue !== null) onChange(nextValue);
      }}
      onBlur={(event) => {
        event.currentTarget.setCustomValidity("");
        setDraft(formatZonedDateTimeInput(value, timeZone));
      }}
    />
  );
}
