# Epidemics data processing and modelling toolkit

A data library and a toolkit for modelling COVID-19 epidemics.

## Issue tracking
Please use the [covid](https://github.com/epidemics/covid/issues/new/choose) repository to submit issues.

## Main concepts

* Region database (continents, countries, provinces, GLEAM basins) - codes, names, basic stats, tree structure (TODO).
* Each region has an ISO-based code, all datasets are organized by those codes (as a row index).
* Built on Pandas with some helpers, using mostly CSVs and HDF5.
* Algorithms and imports assuming common dataframe structure (with `Code` and optionally `Date` row index).
* All dates are UTC timestamps, stored in ISO format with TZ.
* Most of the data is stored in [epimodel-covid-data](https://github.com/epidemics/epimodel-covid-data) repo for asynchronous updates.


## Contributing

For the contribution details and project management, please see [this specification](https://www.notion.so/Development-project-management-476f3c53b0f24171a78146365072d82e).


## Install

* [Get Poetry](https://python-poetry.org/docs/#installation)
* Clone this repository.
* Install the dependencies and this lib `poetry install` (creates a virtual env by default).

```sh
## Clone the repositories (or use their https://... withou github login)
git clone git@github.com:epidemics/epimodel.git
cd epimodel

## Install packages
poetry install  # poetry creates its own virtualenv

poetry shell # activating the virtualenv (if not active already)
poetry run luigi  # running a command in the virtualenv

# Alternatively, you can also install PyMC3 or Pyro, and jupyter (in both cases):
poetry install -E pymc3
poetry install -E pyro
```

* Install the [R language](https://www.r-project.org/about.html): for example `apt install r-base`
  * Optionally: install the packages required by the `scripts/estimate_R.R` script. The script should install them automatically but its a point of common failure.
  * For a fresh R installation, run `chooseCRANmirror()` interactively in the R shell.  

* Get [GLEAMviz](https://sim.gleamviz.org/) and register an account

## Running the pipeline
We are using [luigi](https://luigi.readthedocs.io/en/stable/index.html) as the workflow framework. This
readme doesn't include description of how to use `luigi` so please refer to the project documentation
to understand how to tweak this.

There is an example of the usage with explanations in `scripts/run-interactive.sh` that configures the 
pipeline and runs it for you.

### Configuring Luigi
We generate the Luigi configuration from the default.cfg and additional secrets.cfg. The secrets.cfg 
are not committed to the repository and you can override the defaults to fit your own local configuration. 
Notably you should configure the `UpdateForetold.foretold_channel` section if you wish to use the task 
UpdateForetold or any task it depends on.

A example secrets.cfg that should enable you to run the pipeline with minimal additional configuration:
```
[UpdateForetold]
foretold_channel = 1221122-2212212

[ExportSimulationDefinitions]
simulations_dir = /home/bob/GLEAMviz/data/simulations

[ExtractSimulationsResults]
simulation_directory = /home/bob/GLEAMviz/data/simulations
```

### The usual flow
You provide all file inputs, foretold_channel and parameters, tweak configs to your liking and then:

1. `./run-luigi ExportSimulationDefinitions`
2. run [GLEAMviz](https://sim.gleamviz.org/) with the simulations created above, retrieve results via it's UI, close it
3. export the data using

    ```
    ./run-luigi WebExport \
    --export-name my-export 
    ```

4. upload the result data using `./run-luigi WebUpload --export-data data-dir/outputs/web-exports/my-export` task

### Example with faked data
This example skips the `UpdateForetold` and `ExtractSimulationsResults` task by providing their output.
In reality, you want to actually run GLEAMviz in between and provide Foretold channel to get data via API.
This by default uses data in `data/inputs` and exports data to `data/outputs/example`.
```
# `poetry shell`  # if you haven't done already
./run-luigi WebExport \
    --export-name test-export \
    --UpdateForetold-foretold-output data-dir/inputs/fixtures/foretold.csv \
    --ExtractSimulationsResults-models-file data-dir/inputs/fixtures/gleam-models.hdf5 \
    --ExtractSimulationsResults-simulation-directory this-is-now-ignored
```

After the pipeline finishes, you should see the results in `data-dir/outputs/example/`

### Usage tips
Luigi by default uses `luigi.cfg` from the root of the repository. You can edit it directly or 
you can created another one and reference it via `LUIGI_CONFIG_PATH=your-config.cfg`. `your-config.cfg` 
will take precedence over the `luigi.cfg`, so you can change only what's necessary. However, the overrides 
that are specified in the secrets.cfg will override whatever you have defined in your custom configuration.
For example, if you wanted to have a different input and output directory for a specific location run, 
you could have:

```
# balochistan.cfg

[DEFAULT]
output_directory = my-outputs/balochistan

[RegionsAggregates]
aggregates = data-dir/your-specific-file-for-aggregates.yaml
```

and then `env LUIGI_CONFIG_PATH=balochistan.cfg ./run-luigi RegionsDatasetTask` would make all outputs 
go to `my-outputs/balochistan` (instead of the outputs dir from `luigi.cfg`) and the `RegionsAggregates.aggregates` 
would be taken from the new location too . Parameters from configs can be still overriden from CLI, so 
`env LUIGI_CONFIG_PATH=balochistan.cfg ./run-luigi RegionsDatasetTask --RegionsAggregates-aggregates some-other-path.yaml` 
would still take precedence.


### Getting help
See `epimodel/tasks.py` where the whole pipeline is defined. Read the docstrings and paramter descriptions
to understand and discover all available tasks, their inputs, outputs and their configuration.

You can also use `./run-luigi <TaskName> --help` or `./run-luigi <TaskName> --help-all` to get information about the parameters of the task.

`luigi-deps-tree --module epimodel.tasks <TaskName>` enables you to visualize the dependencies and what is and isn't completed. For example:

```
$ luigi-deps-tree --module epimodel.tasks JohnsHopkins --RegionsFile-regions different-regions.csv
└─--[JohnsHopkins-{'hopkins_output': 'data-dir/outputs/john-hopkins.csv'} (PENDING)]
   |--[RegionsFile-{'regions': 'different-regions.csv'} (PENDING)]
   |--[GleamRegions-{'gleams': 'data-dir/inputs/manual/regions-gleam.csv'} (COMPLETE)]
   └─--[RegionsAggregates-{'aggregates': 'data-dir/inputs/manual/regions-agg.yaml'} (COMPLETE)]
```

## Manual Inputs

#### ConfigYaml

This holds the confguration for web-export including the groups and traces used to generate the GLEAMviz definitions. More documentation can be found in the [default config file](data-dir/inputs/manual/config.yaml).

#### RegionsFile & GleamRegions

These are stable CSVs and you shouldn't have to edit them.

#### RegionsAggregates

Documentation is in [the file](data-dir/inputs/manual/regions-agg.yaml).

#### BaseDefinition

This a pre-formatted XML file. Modifying it changes the default gleam parameters. If you do change it, only change the values, not the structure.

#### GleamParameters

This is a CSV whose format is documented in the [example sheet](https://docs.google.com/spreadsheets/d/1IxPMadPxjnphWSKG_6PxmsrCLoXe3cHGp1Ok9kcddPk/edit#gid=1831691945).

#### CountryEstimates

This gives estimates for the Infectious compartment and Beta values for various regions.

#### Rates

#### Timezones

#### AgeDistributions


## Development

* Use Poetry for dependency management.
* We enforce [black](https://github.com/psf/black) formatting (with the default style).
* Use `pytest` for testing, add tests for your code
* Use pull requests for both this and the data repository.

## Using docker
If you have docker compose, simply use:
```
docker-compose run luigi <luigi-parameters>
```
so for example:
```
docker-compose run luigi JohnsHopkins
```
the image currently doesn't contain `gsutil` available, so the upload my be still necessary from the host

## Running the NPI Model

The NPI Model is specified as a separate Luigi task along with a Luigi task that exports the results into a 
separate web export. Running the NPI Model locally is as simple as running the Luigi task: `run_luigi NPIModel` 
and `run_luigi ExportNPIModelResults`. 

The NPI model pipeline is accompanied by a github workflow that will prepare a NPI model run on the EpiFor Google Cloud 
in a dedicated virtual instance. In order to run this workflow you can go to the 
[GitHub Actions UI](https://github.com/epidemics/covid/actions?query=workflow%3A%22Compute+npi-model+and+upload%22)
where you can select Run Workflow in the top right. Select the branch you want to run from (`master`) and the channel 
you want to publish the results to, for example `staging` or `main` for the staging and published channels.
The resulting model will then be visible at `http://epidemicforecasting.org/country-rt-estimates?channel=model` - 
replace model by the channel you specified. **!! The model takes about 10 hours to compute via this pipeline so be patient !!**
