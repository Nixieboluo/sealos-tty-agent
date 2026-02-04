import antfu from '@antfu/eslint-config'

export default antfu(
	{
		formatters: true,
		typescript: {
			tsconfigPath: 'tsconfig.json',
		},
		stylistic: {
			indent: 'tab',
		},
	},
	{
		rules: {
			'node/prefer-global/process': 'off',
		},
	},
)
