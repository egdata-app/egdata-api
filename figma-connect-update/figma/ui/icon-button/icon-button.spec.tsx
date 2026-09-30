import React from 'react';
import { render } from '@testing-library/react';
import {
  IconButtonExample,
  IconButtonDisabled,
} from './icon-button.compositions.js';

describe('IconButton', () => {
  it('should render the text in the button', () => {
    const { getByText, container } = render(<IconButtonExample />);
    const result = getByText('Terminate');

    expect(container).toContain(result);
  });
  it('should render a disabled button', () => {
    const { getByText } = render(<IconButtonDisabled />);
    const result = getByText('Terminate');

    expect(result).toHaveProperty('disabled');
  });
});
