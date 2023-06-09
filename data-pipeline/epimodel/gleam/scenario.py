from uuid import UUID
from collections import namedtuple
from typing import Tuple, Optional
from pathlib import Path

import numpy as np
import pandas as pd

from tqdm import tqdm
from epimodel import RegionDataset, Level, algorithms
from .definition import GleamDefinition

try:
    import ergo
except ModuleNotFoundError:
    # foretold functionality optional
    ergo = None


class InputParser:
    """
    encapsulates credentials and logic for loading spreadsheet data and
    formatting it for use by the rest of the scenario classes
    """

    PARAMETER_FIELDS = [
        "Region",
        "Value",
        "Parameter",
        "Start date",
        "End date",
        "Type",
        "Class",
    ]
    ESTIMATE_FIELDS = [
        "Region",
        "Infectious",
        "Exposed",
    ]

    def __init__(self, rds: RegionDataset, foretold_token=None, progress_bar=True):
        self.rds = rds
        self.foretold = ergo.Foretold(foretold_token) if foretold_token else None
        self.progress_bar = progress_bar
        algorithms.estimate_missing_populations(rds)

    def parse_estimates_df(self, raw_estimates: pd.DataFrame):
        est = raw_estimates.replace({"": None, "#N/A": None}).dropna(subset=["Name"])

        # distribute_down_with_population requires specifically-formatted input
        compartments_df = pd.DataFrame(
            {
                "Region": est["Name"]
                .apply(self._get_region)
                .apply(lambda reg: reg.Code),
                "Infectious": est["Infectious"].astype("float"),
                "Exposed": est["Exposed"].astype("float"),
            }
        ).set_index("Region")

        infectious_distributed = compartments_df["Infectious"]
        exposed_distributed = compartments_df["Exposed"]

        # modifies series in-place, adding to the index
        algorithms.distribute_down_with_population(infectious_distributed, self.rds)
        algorithms.distribute_down_with_population(exposed_distributed, self.rds)

        df = pd.DataFrame([infectious_distributed, exposed_distributed]).T
        df.index = df.index.set_names(["Region"])
        df = df.reset_index()
        df["Region"] = df["Region"].apply(self._get_region)
        is_gleam_basin = df["Region"].apply(
            lambda region: region.Level == Level.gleam_basin
        )

        return df.loc[is_gleam_basin, :].dropna()

    def parse_country_scenarios_df(self, raw_estimates: pd.DataFrame):
        est = raw_estimates.replace({"": None, "#N/A": None}).dropna(subset=["Name"])

        scenario_columns = [
            scenario_col
            for scenario_col in est.columns
            if scenario_col.startswith("scenario")
        ]
        scenarios = {
            "Region": est["Name"].apply(self._get_region).apply(lambda reg: reg.Code),
        }
        scenarios.update(
            {
                scenario_col: est[scenario_col].astype("float")
                for scenario_col in scenario_columns
            }
        )
        df = pd.DataFrame(scenarios).set_index("Region")

        algorithms.assign_down_with_population(df, self.rds)

        df.index = df.index.set_names(["Region"])
        df = df.reset_index()
        df["Region"] = df["Region"].apply(self._get_region)
        is_gleam_basin = df["Region"].apply(
            lambda region: region.Level == Level.gleam_basin
        )

        return df.loc[is_gleam_basin, ["Region"] + scenario_columns].dropna()

    def parse_parameters_df(self, raw_parameters: pd.DataFrame):
        df = raw_parameters.replace({"": None})[self.PARAMETER_FIELDS].dropna(
            subset=["Parameter"]
        )

        df["Start date"] = pd.to_datetime(df["Start date"])
        df["End date"] = pd.to_datetime(df["End date"])

        # Setting the time range of parameters with nan dates to the time range of the run
        # The first run date value will be used.
        start_date, end_date = df.loc[
            df["Parameter"] == "run dates", ["Start date", "End date"]
        ].iloc[0]

        df.loc[df["Start date"].isna(), "Start date"] = start_date
        df.loc[df["End date"].isna(), "End date"] = end_date

        df["Region"] = df["Region"].apply(self._get_region)
        df["Value"] = self._foretold(df["Value"])
        return df

    def _foretold(self, values: pd.Series):
        values = values.copy()
        uuid_filter = values.apply(self._is_uuid)
        values[uuid_filter] = [
            self._get_foretold_mean(uuid)
            for uuid in self._progress_bar(
                values[uuid_filter], desc="fetching Foretold distributions"
            )
        ]
        return values

    @staticmethod
    def _is_uuid(value):
        try:
            UUID(value, version=4)
            return True
        except (ValueError, AttributeError, TypeError):
            return False

    def _get_foretold_mean(self, uuid: str):
        question_distribution = self.foretold.get_question(uuid)
        # Sample the centers of 100 1%-wide quantiles
        qs = np.arange(0.005, 1.0, 0.01)
        ys = np.array([question_distribution.quantile(q) for q in qs])
        mean = np.sum(ys) / len(qs)
        return mean

    def _get_region(self, code_or_name: str):
        if pd.isnull(code_or_name):
            return None

        region = self.rds.find_first_by_code_or_name(code_or_name)

        if pd.isnull(region.GleamID):
            raise ValueError(f"Region {region!r} has no GleamID")
        return region

    def _progress_bar(self, enum, desc=None):
        if self.progress_bar:
            return tqdm(enum, desc=desc)
        return enum


class SimulationSet:
    """
    generates a matrix of different simulations from the config df based
    on the cartesian product of groups X traces
    """

    def __init__(
        self,
        config: dict,
        parameters: pd.DataFrame,
        estimates: pd.DataFrame,
        country_scenarios: pd.DataFrame,
        base_xml_path: Optional[str] = None,
    ):
        self.config = config
        self.base_xml_path = base_xml_path

        self._store_classes()
        self._prepare_ids()
        self._store_parameters(parameters)
        self._store_estimates(estimates)
        self._country_scenarios = country_scenarios

        self._generate_scenario_definitions()

    def __getitem__(self, classes: Tuple[str, str]):
        return self.builders[classes]

    def __contains__(self, classes: Tuple[str, str]):
        return classes in self.builders.index

    def __iter__(self):
        return self.builders.iteritems()

    @property
    def definitions(self):
        return self.builders.apply(lambda builder: builder.definition)

    def _store_classes(self):
        self.groups = [group["name"] for group in self.config["groups"]]
        self.traces = [trace["name"] for trace in self.config["traces"]]

    def _prepare_ids(self):
        """
        IDs are bit-shifted so every 2-class combo has a unique result
        when the ids are added. This is then added to the base_id to
        make the resulting id sufficiently large and unique.
        """
        self.base_id = int(pd.Timestamp.utcnow().timestamp() * 1000)
        # create one list so all ids are unique
        ids = [1 << i for i in range(len(self.groups) + len(self.traces))]
        # split the list into separate dicts
        self.group_ids = dict(zip(self.groups, ids[: len(self.groups)]))
        self.trace_ids = dict(zip(self.traces, ids[len(self.groups) :]))

    def _id_for_class_pair(self, group: str, trace: str):
        return self.base_id + self.group_ids[group] + self.trace_ids[trace]

    def _store_parameters(self, df: pd.DataFrame):
        # assume unspecified types are traces
        df = df.copy()
        df["Type"] = df["Type"].fillna("trace")

        is_group = df["Type"] == "group"
        is_trace = df["Type"] == "trace"
        if not df[~is_group & ~is_trace].empty:
            bad_types = list(df[~is_group & ~is_trace]["Type"].unique())
            raise ValueError(f"input contains invalid Type values: {bad_types!r}")

        self.group_df = df[is_group]
        self.trace_df = df[is_trace]

        # rows with no class are applied to all simulations
        self.all_groups_df = self.group_df[pd.isnull(self.group_df["Class"])]
        self.all_classes_df = self.trace_df[pd.isnull(self.trace_df["Class"])]

    def _store_estimates(self, estimates: pd.DataFrame):
        if estimates.empty:
            self.estimates = pd.DataFrame(columns=["Region"])
            return

        if "compartment_multipliers" not in self.config:
            self.estimates = estimates
            return

        # Create compartment sizes
        multipliers = self.config["compartment_multipliers"]
        infectious = estimates["Infectious"]
        max_infectious = (
            estimates["Region"].apply(lambda reg: reg.Population)
            * self.config["compartments_max_fraction"]
            / sum(multipliers.values())
        )
        max_infectious.fillna(infectious, inplace=True)
        infectious = np.minimum(infectious, max_infectious)

        # Apply compartment multipliers
        self.estimates = estimates[["Region"]].copy()
        for compartment, multiplier in multipliers.items():
            self.estimates[compartment] = (infectious * multiplier).astype("int")

    def _generate_scenario_definitions(self):
        index = pd.MultiIndex.from_product([self.groups, self.traces])
        self.builders = pd.Series(
            [self._definition_for_class_pair(*pair) for pair in index], index=index
        )

    def _definition_for_class_pair(self, group: str, trace: str):
        group_df = self.group_df[self.group_df["Class"] == group]
        trace_df = self.trace_df[self.trace_df["Class"] == trace]
        return DefinitionBuilder(
            # ensure that group exceptions come before trace exceptions
            pd.concat([group_df, self.all_groups_df, trace_df, self.all_classes_df]),
            estimates=self.estimates,
            country_scenarios=self._country_scenarios,
            id=self._id_for_class_pair(group, trace),
            name=self.config.get("name"),
            group=group,
            trace=trace,
            xml_path=self.base_xml_path,
        )


class DefinitionBuilder:
    """
    Takes DataFrames for parameters and exceptions, and translates them
    into a fully-formed GleamDefinition object.
    """

    GLOBAL_PARAMETERS = {
        "duration": "set_duration",
        "number of runs": "set_run_count",
        "airline traffic": "set_airline_traffic",
        "seasonality": "set_seasonality",
        "commuting time": "set_commuting_rate",
    }
    COMPARTMENT_VARIABLES = (
        "beta",
        "epsilon",
        "mu",
        "imu",
    )

    def __init__(
        self,
        parameters: pd.DataFrame,
        estimates: pd.DataFrame,
        country_scenarios: pd.DataFrame,
        id: int,
        name: str,
        group: str,
        trace: str,
        xml_path: str,
    ):
        self.definition = GleamDefinition(xml_path)
        self.group = group
        self.trace = trace
        self._country_scenarios = country_scenarios

        self.definition.set_id(id)
        self._set_name(name, group, trace)

        self._parse_parameters(parameters)
        self._set_global_parameters()
        self._set_global_compartment_variables()
        self._set_exceptions()
        self._set_estimates(estimates)
        self._set_scenarios()

    @property
    def filename(self):
        return f"{self.definition.get_id_str()}.xml"

    def save_to_dir(self, dir: Path):
        self.definition.save(dir / self.filename)

    def _set_name(self, name: str, group: str, trace: str):
        self.definition.set_name(f"{name} ({group} + {trace})")

    def _parse_parameters(self, df: pd.DataFrame):
        has_exception_fields = pd.notnull(df[["Region", "Start date", "End date"]])
        has_compartment_param = df["Parameter"].isin(self.COMPARTMENT_VARIABLES)

        is_exception = has_compartment_param & has_exception_fields.all(axis=1)
        is_compartment = has_compartment_param & ~is_exception
        is_multiplier = df["Parameter"].str.contains(" multiplier")
        is_compartment_scenario = df["Parameter"].str.contains("scenario")
        is_parameter = (
            ~has_compartment_param & ~is_multiplier & ~is_compartment_scenario
        )

        multipliers = self._prepare_multipliers(df[is_multiplier])
        if multipliers:
            df = df.copy()
            for param, multiplier in multipliers.items():
                if param not in self.COMPARTMENT_VARIABLES:
                    raise ValueError("Cannot apply multiplier to {param!r}")
                df.loc[df["Parameter"] == param, "Value"] = df.loc[
                    df["Parameter"] == param, "Value"
                ].astype(np.float) * float(multiplier)

        self.parameters = df[is_parameter]
        self.compartments = df[is_compartment][["Parameter", "Value"]]
        self.exceptions = self._prepare_exceptions(df[is_exception])
        self.compartment_scenarios = self._prepare_scenarios(
            df[is_compartment_scenario]
        )

    def _set_global_parameters(self):
        self._assert_no_duplicate_values(self.parameters)

        for _, row in self.parameters.iterrows():
            self._set_parameter_from_df_row(row)

    def _set_global_compartment_variables(self):
        self._assert_no_duplicate_values(self.compartments)

        for _, (name, val) in self.compartments.iterrows():
            self.definition.set_compartment_variable(name, float(val))

    def _set_estimates(self, estimates: pd.DataFrame):
        self.definition.set_seeds(estimates)
        self.definition.set_initial_compartments_from_estimates(estimates)

    def _set_exceptions(self):
        self.definition.clear_exceptions()
        for _, row in self.exceptions.iterrows():
            self.definition.add_exception(*row)
        self.definition.format_exceptions()

    def _set_scenarios(self):
        for _, row in self.compartment_scenarios.iterrows():
            self.definition.add_exception(*row)
        self.definition.format_exceptions()

    def _prepare_exceptions(self, exceptions: pd.DataFrame) -> pd.DataFrame:
        """
        Group by time period and region set, creating a new df where
        each row corresponds to the Definition.add_exception interface,
        with regions as an array and variables as a dict.
        """
        output_columns = ["regions", "variables", "start", "end"]
        if exceptions.empty:
            return pd.DataFrame(columns=output_columns)
        return (
            exceptions.groupby(["Parameter", "Value", "Start date", "End date"])
            .apply(lambda group: tuple(sorted(set(group["Region"]))))
            .reset_index()
            .rename(columns={0: "regions"})
            .groupby(["regions", "Start date", "End date"])
            .apply(lambda group: dict(zip(group["Parameter"], group["Value"])))
            .reset_index()
            .rename(
                columns={
                    0: "variables",
                    "Start date": "start",
                    "End date": "end",
                }
            )[output_columns]
        )

    def _prepare_scenarios(self, r_scenarios: pd.DataFrame) -> pd.DataFrame:
        output_columns = ["regions", "variables", "start", "end"]
        if r_scenarios.empty:
            return pd.DataFrame(columns=output_columns)

        df = (
            r_scenarios.groupby(["Parameter", "Value", "Start date", "End date"])
            .apply(self._prepare_scenario)
            .reset_index()
            .groupby(["region", "start", "end"])
            .first(numeric_only=True)
            .reset_index()
            .groupby(list(self.COMPARTMENT_VARIABLES) + ["start", "end"], dropna=False)
            .apply(lambda group: tuple(sorted(set(group["region"]))))
            .reset_index()
            .rename(columns={0: "regions"})
        )
        df["variables"] = df[list(self.COMPARTMENT_VARIABLES)].apply(
            lambda row: row.dropna().to_dict(), axis=1
        )

        return df[output_columns]

    def _prepare_scenario(self, scenario: pd.DataFrame) -> pd.DataFrame:
        variable = scenario["Parameter"].str.replace(" scenario", "").item()
        value = scenario["Value"].item()

        scenario_column = f"scenario-{variable}-{value}-{self.trace}"
        country_scenario = self._country_scenarios[["Region", scenario_column]]
        df = pd.DataFrame(
            {
                "region": country_scenario["Region"],
                variable: country_scenario[scenario_column],
                "start": scenario["Start date"].item(),
                "end": scenario["End date"].item(),
            }
        )

        other_variables = [
            compartment_var
            for compartment_var in self.COMPARTMENT_VARIABLES
            if compartment_var != variable
        ]
        df[other_variables] = pd.DataFrame(
            [[np.nan] * len(other_variables)], index=df.index
        )

        return df

    def _prepare_multipliers(self, multipliers: pd.DataFrame) -> dict:
        """ returns a dict of param: multiplier pairs """
        self._assert_no_duplicate_values(multipliers)
        return dict(
            zip(
                multipliers["Parameter"].str.replace(" multiplier", ""),
                multipliers["Value"],
            )
        )

    def _set_parameter_from_df_row(self, row: namedtuple):
        param = row["Parameter"]
        if param == "run dates":
            if pd.notnull(row["Start date"]):
                self.definition.set_start_date(row["Start date"])
            if pd.notnull(row["End date"]):
                self.definition.set_end_date(row["End date"])
        else:
            value = float(row["Value"])
            getattr(self.definition, self.GLOBAL_PARAMETERS[param])(value)

    def _assert_no_duplicate_values(self, df: pd.DataFrame):
        if "Start date" in df.columns:
            counts = df.groupby(["Parameter", "Start date", "End date"], dropna=False)[
                "Value"
            ].count()
        else:
            counts = df.groupby("Parameter")["Value"].count()
        duplicates = list(counts[counts > 1].index)
        if duplicates:
            raise ValueError(
                "Duplicate values passed to a single scenario "
                f"for the following parameters: {duplicates!r}"
            )
