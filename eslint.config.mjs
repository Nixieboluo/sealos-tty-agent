import antfu from '@antfu/eslint-config'

export default antfu(
	{
		formatters: true,
		typescript: {
			tsconfigPath: 'tsconfig.eslint.json',
		},
		stylistic: {
			indent: 'tab',
		},
	},
	{
		rules: {
			'node/prefer-global/process': 'off',
			'ts/consistent-type-definitions': ['error', 'type'],
		},
	},
)
