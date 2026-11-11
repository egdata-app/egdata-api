import {
  type FormProps,
  Form as RACForm,
  TextField as RACTextField,
  type TextFieldProps as RACTextFieldProps,
  type ValidationResult,
} from "react-aria-components";
import { twMerge } from "tailwind-merge";
import { Description, FieldError, Input, Label, TextArea } from "./Field";
import { composeTailwindRenderProps } from "./utils";

export interface TextFieldProps extends RACTextFieldProps {
  label?: string;
  description?: string;
  placeholder?: string;
  multiline?: boolean;
  errorMessage?: string | ((validation: ValidationResult) => string);
}

export function TextField({
  label,
  description,
  errorMessage,
  placeholder,
  multiline,
  ...props
}: TextFieldProps) {
  return (
    <RACTextField
      {...props}
      className={composeTailwindRenderProps(
        props.className,
        "group flex flex-col gap-1.5",
      )}
    >
      {label && <Label>{label}</Label>}
      {multiline ? (
        <TextArea placeholder={placeholder} />
      ) : (
        <Input placeholder={placeholder} />
      )}
      {description && <Description>{description}</Description>}
      <FieldError>{errorMessage}</FieldError>
    </RACTextField>
  );
}

export function Form(props: FormProps) {
  return (
    <RACForm
      {...props}
      className={twMerge("flex flex-col gap-4", props.className)}
    />
  );
}
