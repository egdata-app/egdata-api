import React, { ReactElement } from 'react';
import cx from 'classnames';
import Button, { ButtonProps } from '@teambit/base-ui.input.button';
import { CircleLoader } from '@teambit/design.loaders.circle-loader';
import styles from './icon-button.module.scss';
import sizes from './sizes.module.scss';

export type IconButtonProps = {
  /**
   * An optional Icon element to be render at the start of the button, can be an Image or an Icon.
   */
  icon?: ReactElement;
  /**
   * indicate button is on
   */
  active?: boolean;
  /**
   * style variance
   */
  priority?: 'ghost' | 'cta';
  /**
   * color accent
   */
  accent?: 'danger' | 'success';
  /**
   * button sizes
   */
  size?: 's' | 'm' | 'l' | null;
  /**
   * with or without border.
   */
  border?: boolean;
} & ButtonProps;

/**
 *
 * Generic button that supports text, icon and integration of both
 */
export function IconButton({
  icon,
  className,
  children,
  active,
  priority = 'ghost',
  accent,
  size = 's',
  border = true,
  ...rest
}: IconButtonProps) {
  return (
    // @ts-expect-error
    <Button
      className={cx(
        styles.iconButton,
        sizes.buttonSizes,
        active && styles.active,
        icon && !children && styles.iconOnly,
        icon && children && styles.margin,
        icon && styles.withIcon,
        !border && styles.withoutBorder,
        styles[accent as string],
        rest.loading && styles.loading,
        className
      )}
      loader={
        <CircleLoader
          className={cx(styles.loader, sizes.loaderSizes)}
          data-size={size}
        />
      }
      data-priority={priority}
      data-size={size}
      {...rest}
    >
      {icon}
      {children}
    </Button>
  );
}
