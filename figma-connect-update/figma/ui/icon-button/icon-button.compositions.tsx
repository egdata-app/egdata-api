import React from 'react';
import { Icon } from '@teambit/design.elements.icon';
import { figma } from '@figma/code-connect';
import { IconButton } from './index.js';

figma.connect(
  IconButton,
  'https://www.figma.com/design/o28uGKDnbCQWhjk2VvZhVh/Test-%2F%2F%2F-Button-%2F%2F%2F?node-id=901-2423&m=dev',
  {
    props: {
      style: figma.enum('Type', {
        Ghost: 'ghost',
        Social: 'cta',
      }),
      size: figma.enum('Size', {
        Small: 's',
        Medium: 'm',
        Big: 'l',
      }),
      icon: figma.boolean('Leading Icon', {
        true: <Icon of="error-circle" />,
        false: undefined,
      }),
      children: figma.boolean('Text view', {
        true: 'Button',
        false: undefined,
      }),
    },
    example: ({ style, size, icon, children, ...props }) => {
      return (
        <IconButton {...props} priority={style} size={size} icon={icon}>
          {children}
        </IconButton>
      );
    },
  }
);

export function IconButtonExample() {
  return <IconButton icon={<Icon of="error-circle" />}>Terminate</IconButton>;
}

export function IconButtonDisabled() {
  return (
    <IconButton icon={<Icon of="error-circle" />} disabled>
      Terminate
    </IconButton>
  );
}

export function IconOnlyButtonExample() {
  return <IconButton icon={<Icon of="error-circle" />} />
}

export function IconOnlyButtonWithoutBorderExample() {
  return (
    <IconButton border={false} icon={<Icon of="error-circle" />} />
  );
}

export function TextOnlyButtonExample() {
  return <IconButton>Terminate</IconButton>;
}

export function LoadingButtonExample() {
  return <IconButton loading />;
}

export function ActiveButtonExample() {
  return <IconButton active>Terminate</IconButton>;
}

export function ActiveWithIconButtonExample() {
  return (
    <IconButton active icon={<Icon of="error-circle" />}>
      Terminate
    </IconButton>
  );
}

export function SmallActiveIconOnlyWithOverrideSize() {
  return (
    <IconButton
      icon={<Icon of="plus" />}
      active
      size={null}
      style={{ width: 24, height: 24, justifyContent: 'center' }}
    />
  );
}

export function DefaultButton() {
  return <IconButton priority="ghost">Update</IconButton>;
}

export function GhostDisableButton() {
  return (
    <IconButton priority="ghost" disabled>
      Update
    </IconButton>
  );
}

export function CtaButton() {
  return <IconButton priority="cta">Save</IconButton>;
}

export function CtaButtonWithIcon() {
  return (
    <IconButton priority="cta" icon={<Icon of="download" />}>
      Save
    </IconButton>
  );
}

export function LargeCtaButton() {
  return (
    <IconButton priority="cta" size="l">
      Save
    </IconButton>
  );
}

export function CtaDisableButton() {
  return (
    <IconButton priority="cta" disabled>
      Delete
    </IconButton>
  );
}

export function CtaDangerButton() {
  return (
    <IconButton priority="cta" accent="danger">
      Delete
    </IconButton>
  );
}

export function LargeDangerButton() {
  return (
    <IconButton priority="cta" size="l" accent="danger">
      Delete
    </IconButton>
  );
}

export function DangerDisabledButton() {
  return (
    <IconButton priority="cta" accent="danger" disabled>
      Delete
    </IconButton>
  );
}

export function CtaSuccessButton() {
  return (
    <IconButton priority="cta" accent="success">
      Saved!
    </IconButton>
  );
}

export function ButtonWithImage() {
  return (
    <IconButton
      icon={<img src="https://static.bit.dev/brands/logo-google.svg" alt="" />}
    >
      Login With Google
    </IconButton>
  );
}

export function DisabledButtonWithImage() {
  return (
    <IconButton
      disabled
      icon={<img src="https://static.bit.dev/brands/logo-google.svg" alt="" />}
    >
      Login With Google
    </IconButton>
  );
}

export function LargeButtonWithImage() {
  return (
    <IconButton
      size="l"
      icon={<img src="https://static.bit.dev/brands/logo-google.svg" alt="" />}
    >
      Login With Google
    </IconButton>
  );
}
